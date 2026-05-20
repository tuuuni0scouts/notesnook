# PDF Annotation in Notesnook — Implementation Plan

## Philosophy & Guiding Principles

Notesnook exists to prove that privacy and convenience are not mutually exclusive.
Any PDF annotation feature must hold to the same bar:

- **Encrypted by default.** Annotations are part of note content. They are
  encrypted client-side with the same XChaCha20-Poly1305 pipeline as all other
  content. The PDF binary is never mutated in place — only during export.
- **No new dependencies without justification.** The viewer already uses
  `pdfjs-dist` and `@react-pdf-viewer/*`. New packages (`pdf-lib`,
  `perfect-freehand`) are added only where they replace non-trivial custom code.
- **Annotations belong to the note, not the file — until you export.** Inside
  Notesnook, annotations are structured JSON stored alongside the attachment
  reference. On any export that bundles attachments, the PDF in the zip is
  automatically the annotated version.
- **Cross-platform from day one.** Web, desktop (Electron), and mobile (React
  Native + `editor-mobile`) must all be considered in the data model even if UI
  work is phased.
- **Complete annotation support.** Include freehand ink from the start — it is
  one of the most natural ways to mark up a document and the SVG path approach
  is well-understood.

---

## Scope (v1)

| Annotation type | Description |
|---|---|
| Text highlight | Coloured background over a text selection |
| Text underline | Underline mark over a text selection |
| Sticky note / comment | Small pop-up note anchored to a page position |
| Area highlight | Rectangular region highlight on any page |
| Freehand / ink | Free-drawn strokes rendered as smooth SVG paths |
| Export to annotated PDF | Bake annotations into the PDF on every export that includes the attachment |

### Out of scope (v1)

- Mobile annotation UI (data model is shared; touch ink input is a follow-up)
- Real-time collaborative annotations
- Annotation sidebar / list view (follow-up)

---

## Data Model

Annotations are stored as a typed JSON array, encrypted as part of note content.
The PDF binary on disk is never changed; annotations are baked into a PDF only
during an export operation.

```typescript
// packages/editor/src/extensions/attachment/types.ts

type AnnotationColor = "yellow" | "green" | "blue" | "pink" | "orange";

interface BaseAnnotation {
  id: string;           // nanoid — stable across devices after sync
  page: number;         // 0-indexed
  createdAt: number;    // unix ms
  updatedAt: number;
  color: AnnotationColor;
}

interface TextAnnotation extends BaseAnnotation {
  type: "highlight" | "underline";
  rects: PdfRect[];     // bounding boxes in PDF-space (points, not pixels)
  selectedText: string;
  note?: string;
}

interface StickyNoteAnnotation extends BaseAnnotation {
  type: "sticky";
  x: number;            // 0–1, relative to page width
  y: number;            // 0–1, relative to page height
  note: string;
}

interface AreaAnnotation extends BaseAnnotation {
  type: "area";
  x: number; y: number; width: number; height: number;
  note?: string;
}

interface InkAnnotation extends BaseAnnotation {
  type: "ink";
  // Raw simplified points in PDF-space. Stored as input points so the export
  // step can re-render at full resolution without the perfect-freehand library.
  strokes: Array<Array<[number, number]>>;
  strokeWidth: number;
}

export type PdfAnnotation =
  | TextAnnotation
  | StickyNoteAnnotation
  | AreaAnnotation
  | InkAnnotation;

export type PdfRect = { x: number; y: number; width: number; height: number };
```

### Attachment node — new `annotations` attribute

```typescript
// packages/editor/src/extensions/attachment/index.ts

annotations: {
  default: [],
  parseHTML: (el) => JSON.parse(el.getAttribute("data-annotations") ?? "[]"),
  renderHTML: (attrs) => ({
    "data-annotations": JSON.stringify(attrs.annotations),
  }),
},
```

Annotations ride inside the Tiptap document JSON — encrypted and synced by
`@notesnook/core` with zero extra infrastructure.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/web/src/components/pdf-preview/                            │
│                                                                  │
│  PdfPreview.tsx            ← existing viewer                     │
│  AnnotationLayer.tsx       ← NEW: SVG overlay (all types)        │
│  InkCanvas.tsx             ← NEW: drawing canvas for ink mode    │
│  AnnotationToolbar.tsx     ← NEW: mode switcher + colours        │
│  StickyNote.tsx            ← NEW: comment pop-up                 │
│  useAnnotations.ts         ← NEW: state + editor commands        │
│  useTextSelection.ts       ← NEW: pdfjs text selection           │
│  useInkStroke.ts           ← NEW: pointer-event stroke input     │
└──────────────────────────┬───────────────────────────────────────┘
                           │ reads/writes via
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  packages/editor/src/extensions/attachment/                      │
│                                                                  │
│  index.ts     ← add annotations attribute                        │
│  commands.ts  ← addPdfAnnotation / updatePdfAnnotation /         │
│                 removePdfAnnotation                              │
│  types.ts     ← PdfAnnotation union + PdfRect                    │
└──────────────────────────┬───────────────────────────────────────┘
                           │ serialised to data-annotations attr
                           ▼ during any export
┌──────────────────────────────────────────────────────────────────┐
│  packages/common/src/utils/export-notes.ts                       │
│                                                                  │
│  ExportableAttachment  ← add annotations?: PdfAnnotation[]       │
│  exportContent()       ← extract data-annotations from elements  │
│                          and attach to ExportableAttachment       │
└──────────────────────────┬───────────────────────────────────────┘
                           │ annotations flow downstream
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  apps/web/src/utils/streams/export-stream.ts  (ExportStream)     │
│                                                                  │
│  attachment handler  ← if PDF + annotations: decrypt → pdf-lib   │
│                        bake → stream annotated bytes to zip      │
└──────────────────────────────────────────────────────────────────┘
                           │ also used by
┌──────────────────────────▼───────────────────────────────────────┐
│  apps/web/src/utils/pdf/applyAnnotations.ts   ← NEW shared util  │
│  (used by ExportStream and by "Export annotated PDF" button)     │
└──────────────────────────────────────────────────────────────────┘
```

---

## How the Export Pipeline Changes

### Current flow (all non-PDF formats with attachments)

```
exportNotes() / exportNote()
  └─ exportContent()
       └─ content.resolveAttachments(callback)
            └─ callback receives: elements = { [hash]: { ...all DOM attrs } }
                 → adds attachment to pendingAttachments map
  └─ yields ExportableAttachment { type, path, data: Attachment }
       └─ ExportStream.transform()
            └─ decrypt → stream bytes → zip entry at attachments/hash-filename.pdf
```

### New flow for PDF attachments with annotations

`data-annotations` is already a rendered HTML attribute on the attachment node.
The `elements` object that `resolveAttachments()` passes to its callback already
contains it. We only need to:

1. Parse it out of `elements[hash]["data-annotations"]` in the callback.
2. Carry it on `ExportableAttachment` as an optional `annotations` field.
3. In `ExportStream`, detect it and pipe through `applyAnnotations` before zipping.

```
exportContent()
  └─ resolveAttachments callback now also reads data-annotations
       → pendingAttachments.set(path, { attachment, annotations })

yields ExportableAttachment { ..., annotations: PdfAnnotation[] }

ExportStream.transform()
  └─ if item.annotations.length > 0 && isPdf(item.data.mimeType):
       1. decrypt → collect full Uint8Array (not stream)
       2. applyAnnotations(bytes, annotations) via pdf-lib
       3. enqueue annotated bytes as ReadableStream → zip
     else:
       existing streaming path (unchanged)
```

The note content file (markdown / HTML) still links to the same relative path
(`attachments/hash-filename.pdf`) — only the PDF bytes at that path change.

### Formats not affected

| Format | Attachment bundled? | Annotations applied? |
|---|---|---|
| `md` | yes (zip) | yes — annotated PDF in zip |
| `md-frontmatter` | yes (zip) | yes — annotated PDF in zip |
| `html` | yes (zip) | yes — annotated PDF in zip |
| `txt` | no (skipped by guard on line 279 of export-notes.ts) | n/a |
| `pdf` (print) | no (iframe print, no attachment bundling) | n/a |

The `format !== "txt" && format !== "pdf"` guard already in `exportContent()`
means the annotation path is only exercised for the three formats that bundle
attachments. No changes to the txt or PDF-print paths.

### Single-note export

`exportNote()` goes through the same `exportContent()` / `ExportStream` path.
No separate handling needed.

### Mobile

`apps/mobile/app/services/exporter.ts` downloads attachments to a local cache
directory and then zips the folder. The same `pdf-lib`-based annotation step
applies after the attachment file is written to cache:

```
downloadAttachment(hash, cachePath)
  └─ if isPdf && annotations.length > 0:
       bytes = fs.readFile(cachePath)
       annotated = applyAnnotations(bytes, annotations)
       fs.writeFile(cachePath, annotated)
zip(cacheDir) → output
```

`pdf-lib` works in React Native. The `applyAnnotations` utility can be shared
from `packages/common` (with `pdf-lib` listed as a peer dep there) or duplicated
in the mobile app — the exact packaging is a decision for the mobile PR.

---

## Shared Annotation Utility

```typescript
// apps/web/src/utils/pdf/applyAnnotations.ts

import { PDFDocument, rgb } from "pdf-lib";
import type { PdfAnnotation } from "@notesnook/editor";
import { annotationColorToRgb } from "./colors";

export async function applyAnnotations(
  pdfBytes: Uint8Array,
  annotations: PdfAnnotation[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();

  for (const ann of annotations) {
    const page = pages[ann.page];
    if (!page) continue;
    const { height } = page.getSize(); // pdf-lib origin is bottom-left

    switch (ann.type) {
      case "highlight":
        for (const r of ann.rects)
          page.drawRectangle({
            x: r.x, y: height - r.y - r.height,
            width: r.width, height: r.height,
            color: annotationColorToRgb(ann.color), opacity: 0.35
          });
        break;
      case "underline":
        for (const r of ann.rects)
          page.drawLine({
            start: { x: r.x, y: height - r.y - r.height },
            end: { x: r.x + r.width, y: height - r.y - r.height },
            color: annotationColorToRgb(ann.color), thickness: 1
          });
        break;
      case "area":
        page.drawRectangle({
          x: ann.x, y: height - ann.y - ann.height,
          width: ann.width, height: ann.height,
          borderColor: annotationColorToRgb(ann.color),
          borderWidth: 1.5, opacity: 0
        });
        break;
      case "sticky":
        // Draw a small filled square as anchor; include text if short enough
        page.drawRectangle({
          x: ann.x * page.getWidth(),
          y: height - ann.y * height - 12,
          width: 12, height: 12,
          color: annotationColorToRgb(ann.color)
        });
        break;
      case "ink":
        for (const stroke of ann.strokes) {
          const d = strokeToSvgPath(stroke);
          page.drawSvgPath(d, {
            x: 0, y: height,
            borderColor: annotationColorToRgb(ann.color),
            borderWidth: ann.strokeWidth
          });
        }
        break;
    }
  }

  return doc.save();
}
```

`strokeToSvgPath` converts the stored `[x, y]` point array to a cubic-bezier
SVG `d` string. `pdf-lib` accepts SVG path syntax in `drawSvgPath`, which is the
same data we use in the SVG overlay, so no separate point-to-curve algorithm is
needed.

---

## File & Package Changes

### `packages/editor/src/extensions/attachment/`

```
types.ts    — add PdfAnnotation, PdfRect, AnnotationColor
index.ts    — add annotations attribute
commands.ts — addPdfAnnotation / updatePdfAnnotation / removePdfAnnotation
```

### `packages/common/src/utils/export-notes.ts`

```
ExportableAttachment   — add annotations?: PdfAnnotation[]
exportContent()        — parse data-annotations from elements in
                         resolveAttachments callback; set on ExportableAttachment
```

### `apps/web/src/utils/pdf/`

```
applyAnnotations.ts    — pdf-lib annotation baking (shared between ExportStream
                         and the manual "Export annotated PDF" button)
colors.ts              — annotationColorToRgb mapping
```

### `apps/web/src/utils/streams/export-stream.ts`

```
attachment handler     — detect PDF + annotations; collect decrypted bytes;
                         call applyAnnotations; enqueue result
```

### `apps/web/src/components/pdf-preview/`

```
AnnotationLayer.tsx     — SVG overlay, all rendered annotation types
InkCanvas.tsx           — transparent drawing canvas for ink mode
AnnotationToolbar.tsx   — mode switcher (select/ink/area/sticky) + colours
StickyNote.tsx          — anchored comment popover
useAnnotations.ts       — read/write via editor commands
useTextSelection.ts     — pdfjs text selection → PdfRect[]
useInkStroke.ts         — pointer events → InkAnnotation stroke points
```

### `apps/web/src/components/pdf-preview/index.tsx` (existing)

- Mount `<AnnotationLayer>` and `<InkCanvas>` as siblings to pdfjs canvases.
- Show `<AnnotationToolbar>` in the viewer header.
- Add "Export annotated PDF" button that calls `applyAnnotations` then downloads.

### `apps/web/src/dialogs/pdf-preview-dialog.tsx` (existing)

- Pass `editor` and `attachmentHash` into `PdfPreview`.

---

## New Dependencies

| Package | Where | Justification |
|---|---|---|
| `pdf-lib` | `apps/web` | Bake annotations into PDF bytes. pdfjs is read-only; no alternative. |
| `perfect-freehand` | `apps/web` | Smooth ink strokes from pointer events. ~3 kB. |

Both added only to `apps/web`. Mobile adds `pdf-lib` separately in its PR.

---

## Implementation Steps

### Step 1 — Types and editor commands

1. Add `PdfAnnotation`, `PdfRect`, `AnnotationColor` to
   `packages/editor/src/extensions/attachment/types.ts`.
2. Add `annotations` attribute to the attachment Tiptap node.
3. Add `addPdfAnnotation`, `updatePdfAnnotation`, `removePdfAnnotation` commands.

### Step 2 — Thread annotations through the export pipeline

1. Extend `ExportableAttachment` in `packages/common/src/utils/export-notes.ts`
   with `annotations?: PdfAnnotation[]`.
2. In the `resolveAttachments` callback, for PDF MIME types, parse
   `elements[attachment.hash]["data-annotations"]` and set it on the yielded
   `ExportableAttachment`.

### Step 3 — applyAnnotations utility

1. Add `pdf-lib` to `apps/web`.
2. Create `apps/web/src/utils/pdf/applyAnnotations.ts` as described above.

### Step 4 — ExportStream annotation baking

1. In `ExportStream.transform()`, when `item.type === "attachment"` and
   `item.annotations?.length && isPdf(item.data.mimeType)`:
   - After decryption, collect the `ReadableStream` into a `Uint8Array`.
   - Call `applyAnnotations(bytes, item.annotations)`.
   - Enqueue the resulting bytes as a new `ReadableStream`.
2. Otherwise follow the existing streaming path unchanged.

### Step 5 — Text selection bridge

1. Create `useTextSelection.ts` in `apps/web/src/components/pdf-preview/`.
2. Listen on `mouseup` after `textlayerrendered`.
3. Read `window.getSelection()`, compute `PdfRect[]` by dividing viewport coords
   by `viewport.scale` and flipping Y to PDF-space.
4. Expose `{ selectedText, rects, page, clear }`.

### Step 6 — Annotation layer

1. Create `AnnotationLayer.tsx` — `<svg>` absolutely positioned per page.
2. Map each annotation type to its SVG element (see Rendering table below).
3. Sticky anchors open `<StickyNote>` on click.

### Step 7 — Ink input

1. Create `useInkStroke.ts` — capture `pointerdown/move/up`, feed to
   `perfect-freehand`, convert final output to PDF-space `[x,y]` points.
2. Create `InkCanvas.tsx` — transparent `<canvas>` active only in ink mode;
   draws live preview; commits stroke on `pointerup`.

### Step 8 — Annotation toolbar

1. Create `AnnotationToolbar.tsx` with mode buttons and colour picker.
2. Floating selection toolbar near text selection; fixed toolbar in viewer header.

### Step 9 — Sticky note popover

1. Create `StickyNote.tsx` — `<textarea>` popover; saves on blur; removes
   annotation when text is cleared.

### Step 10 — Wire up in dialog

1. Thread `editor` and `attachmentHash` from `pdf-preview-dialog.tsx` into
   `PdfPreview`.
2. `useAnnotations` reads annotation array from attachment node and exposes the
   three editor commands.
3. Add "Export annotated PDF" button calling `applyAnnotations` then
   `downloadBlob`.

### Step 11 — Tests

- **Unit (Vitest):** `addPdfAnnotation` / `removePdfAnnotation` commands verify
  annotation array on attachment node attribute for each annotation type.
- **Unit (Vitest):** `applyAnnotations` with a minimal synthetic PDF — assert the
  output is a valid PDF and larger than the input (bytes were added).
- **Unit (Vitest):** `exportContent` with a note whose content contains a PDF
  attachment node with `data-annotations` — assert `ExportableAttachment` carries
  the parsed annotations.
- **E2e (Playwright):** open a PDF attachment, create a text highlight and an
  ink stroke, reload, assert both are rendered. Export the note as Markdown,
  assert the zip contains an `attachments/` folder and the PDF inside it is
  larger than the original (annotations baked in).

---

## Rendering Reference

| Annotation type | SVG element | pdf-lib call |
|---|---|---|
| `highlight` | `<rect fill-opacity="0.35">` per rect | `page.drawRectangle` with opacity |
| `underline` | `<line>` at bottom edge of each rect | `page.drawLine` |
| `area` | `<rect>` with stroke, no fill | `page.drawRectangle` border-only |
| `sticky` | `<g>` with pin icon; `pointer-events: all` | `page.drawRectangle` small square |
| `ink` | `<path>` from `perfect-freehand` output | `page.drawSvgPath` with bezier d string |

---

## Commit & Contribution Guidelines

Follow the project's commit scopes exactly:

```
editor: add PdfAnnotation types, annotations attribute, and commands
misc: extend ExportableAttachment with annotations field
web: add applyAnnotations utility using pdf-lib
web: bake PDF annotations in ExportStream
web: add PDF annotation layer, ink canvas, and toolbar
```

All commits signed with DCO:

```
Signed-off-by: Tuuuni <tuuuni@outlook.com>
```

Open a GitHub issue before starting coding work, reference it in the PR, and run
the full bootstrap + lint + prettier + test cycle before opening the pull request.

---

## Open Questions

1. **Sync conflict resolution.** Last-write-wins works for v1. A per-annotation
   merge by `id` would prevent two devices from clobbering each other's work.
   Worth raising in the issue before merging.

2. **Memory in ExportStream for large PDFs.** The current attachment path uses
   a `ReadableStream` to avoid buffering the whole file. Applying pdf-lib requires
   loading the full file into memory. For a typical annotated research PDF
   (< 50 MB) this is fine, but the PR should note the trade-off and consider
   a memory limit check.

3. **Mobile annotation UI.** The data model is shared. SVG overlay can be ported
   using `react-native-svg`; touch ink is a separate follow-up issue.

4. **Ink stroke storage size.** Dense strokes can generate many points. Apply
   Ramer–Douglas–Peucker simplification (ε ≈ 0.5 pt) before storing to cap point
   counts without visible quality loss.

5. **Annotation sidebar.** A panel listing all annotations with jump-to-page
   links improves navigation on heavily annotated documents. Out of scope v1.
