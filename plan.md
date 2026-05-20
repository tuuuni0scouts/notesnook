# PDF Annotation in Notesnook — Implementation Plan

## Philosophy & Guiding Principles

Notesnook exists to prove that privacy and convenience are not mutually exclusive.
Any PDF annotation feature must hold to the same bar:

- **Encrypted by default.** Annotations are part of note content. They are
  encrypted client-side with the same XChaCha20-Poly1305 pipeline as all other
  content. The PDF binary is never mutated in place — only during an explicit
  export.
- **No new dependencies without justification.** The viewer already uses
  `pdfjs-dist` and `@react-pdf-viewer/*`. New packages (`pdf-lib`,
  `perfect-freehand`) are added only where they replace non-trivial custom code.
- **Annotations belong to the note, not the file — until you export.** Inside
  Notesnook, annotations are structured JSON stored alongside the attachment
  reference. On export, they are baked into a copy of the PDF so the file is
  useful outside the app.
- **Cross-platform from day one.** Web, desktop (Electron), and mobile (React
  Native + `editor-mobile`) must all be considered in the data model even if UI
  work is phased.
- **Complete annotation support.** Include freehand ink from the start — it is
  one of the most natural ways to mark up a document and the SVG path approach
  is straightforward enough to do right.

---

## Scope (v1)

| Annotation type | Description |
|---|---|
| Text highlight | Coloured background over a text selection |
| Text underline | Underline mark over a text selection |
| Sticky note / comment | Small pop-up note anchored to a page position |
| Area highlight | Rectangular region highlight on any page |
| Freehand / ink | Free-drawn strokes rendered as smooth SVG paths |
| **Export to annotated PDF** | Bake all annotations into a downloadable PDF copy |

### Out of scope (v1)

- Mobile annotation UI (data model is shared; touch ink input is a follow-up)
- Real-time collaborative annotations
- Annotation sidebar / list view (follow-up)

---

## Data Model

Annotations are stored as a typed JSON array, encrypted as part of note content.
The PDF binary on disk is never changed; annotations are only written into a PDF
during an explicit export operation.

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
  selectedText: string; // plain text of selection
  note?: string;        // optional user comment
}

interface StickyNoteAnnotation extends BaseAnnotation {
  type: "sticky";
  x: number;            // 0–1, relative to page width
  y: number;            // 0–1, relative to page height
  note: string;
}

interface AreaAnnotation extends BaseAnnotation {
  type: "area";
  x: number;
  y: number;
  width: number;
  height: number;
  note?: string;
}

interface InkAnnotation extends BaseAnnotation {
  type: "ink";
  // Each stroke is an array of [x, y] points in PDF-space.
  // perfect-freehand produces smoothed input points; we store the raw
  // simplified path so the export step can reconstruct it without the library.
  strokes: Array<Array<[number, number]>>;
  strokeWidth: number;
}

type PdfAnnotation =
  | TextAnnotation
  | StickyNoteAnnotation
  | AreaAnnotation
  | InkAnnotation;

// Coordinate helper — PDF-space, zoom-independent
type PdfRect = { x: number; y: number; width: number; height: number };
```

### Attachment node — new `annotations` attribute

The existing `attachment` Tiptap node gains one additional attribute:

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
┌──────────────────────────────────────────────────────────────┐
│  apps/web/src/components/pdf-preview/                        │
│                                                              │
│  PdfPreview.tsx            ← existing viewer                 │
│  AnnotationLayer.tsx       ← NEW: SVG overlay (all types)    │
│  InkCanvas.tsx             ← NEW: drawing canvas for ink     │
│  AnnotationToolbar.tsx     ← NEW: mode switcher + colours    │
│  StickyNote.tsx            ← NEW: comment pop-up             │
│  useAnnotations.ts         ← NEW: state + editor commands    │
│  useTextSelection.ts       ← NEW: pdfjs text selection       │
│  useInkStroke.ts           ← NEW: pointer-event stroke input │
│  exportAnnotatedPdf.ts     ← NEW: pdf-lib export             │
└──────────────────────────┬───────────────────────────────────┘
                           │ reads/writes via
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/editor/src/extensions/attachment/                  │
│                                                              │
│  index.ts     ← add annotations attribute                    │
│  commands.ts  ← addPdfAnnotation / updatePdfAnnotation /     │
│                 removePdfAnnotation                          │
│  types.ts     ← PdfAnnotation union + PdfRect                │
└──────────────────────────┬───────────────────────────────────┘
                           │ encrypted in
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/core  (NoteContent, sync, crypto)                  │
│  No changes needed                                           │
└──────────────────────────────────────────────────────────────┘
```

### Rendering annotations

All annotation types render inside a single `<svg>` absolutely positioned over
each page canvas (`pointer-events: none` by default, selectively re-enabled for
interactive elements). Coordinates are stored in PDF-space (points) and
converted to viewport pixels at render time by multiplying with `viewport.scale`,
so annotations stay correctly placed at any zoom level.

| Type | SVG element |
|---|---|
| `highlight` | `<rect fill-opacity="0.35">` per bounding rect |
| `underline` | `<line>` at the bottom edge of each rect |
| `area` | `<rect>` with stroke, no fill |
| `sticky` | `<g>` with pin icon; `pointer-events: all` |
| `ink` | `<path>` from `perfect-freehand` output; smooth cubic bezier |

### Freehand ink input

While the annotation toolbar is in **ink mode**, a transparent `<canvas>` sits
above the SVG layer with `pointer-events: all`. `useInkStroke` listens to
`pointerdown / pointermove / pointerup` and feeds the raw points to
`perfect-freehand` to produce a smooth stroke outline in real time. On
`pointerup`, the canvas is cleared and the finalised path is committed as an
`InkAnnotation` via `addPdfAnnotation`. Storing raw input points (not the
computed outline) keeps the data model slim and lets the export step re-render
at PDF resolution without relying on the library at runtime.

### Export to annotated PDF

`exportAnnotatedPdf.ts` uses `pdf-lib` to produce an annotated copy:

1. Fetch the original PDF bytes via the existing `getAttachmentData` callback.
2. Load with `PDFDocument.load(bytes)`.
3. For each page, iterate its annotations:
   - `highlight` / `area`: draw filled rectangles with opacity using
     `page.drawRectangle`.
   - `underline`: draw lines with `page.drawLine`.
   - `sticky`: draw a small callout box with the note text using
     `page.drawRectangle` + `page.drawText`.
   - `ink`: reconstruct SVG path points into a series of `page.drawSvgPath`
     calls (pdf-lib supports SVG path syntax directly).
4. Save with `PDFDocument.save()` and trigger a browser download.

The original attachment is untouched. The export is a one-shot operation that
produces a new file.

```typescript
// apps/web/src/components/pdf-preview/exportAnnotatedPdf.ts

export async function exportAnnotatedPdf(
  attachmentHash: string,
  annotations: PdfAnnotation[],
  getAttachmentData: (hash: string) => Promise<Uint8Array>
): Promise<void> {
  const bytes = await getAttachmentData(attachmentHash);
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();

  for (const ann of annotations) {
    const page = pages[ann.page];
    const { height } = page.getSize(); // pdf-lib origin is bottom-left
    drawAnnotation(page, ann, height);
  }

  const output = await doc.save();
  downloadBlob(new Blob([output], { type: "application/pdf" }), "annotated.pdf");
}
```

---

## New Dependencies

| Package | Justification |
|---|---|
| `pdf-lib` | Bake annotations into a PDF copy on export. pdfjs is read-only; no alternative within the existing stack. |
| `perfect-freehand` | Smooth ink strokes from raw pointer events. ~3 kB; eliminates significant geometry code. |

Both are added only to `apps/web` — no impact on the core or editor packages.

---

## File & Package Changes

### `packages/editor/src/extensions/attachment/`

```
types.ts    — add PdfAnnotation, PdfRect types
index.ts    — add annotations attribute
commands.ts — addPdfAnnotation / updatePdfAnnotation / removePdfAnnotation
```

### `apps/web/src/components/pdf-preview/`

```
AnnotationLayer.tsx     — SVG overlay, all rendered annotation types
InkCanvas.tsx           — transparent drawing canvas for ink mode
AnnotationToolbar.tsx   — mode switcher (select / ink / area / sticky) + colours
StickyNote.tsx          — anchored comment popover
useAnnotations.ts       — read/write annotations via editor commands
useTextSelection.ts     — pdfjs text selection → PdfRect[]
useInkStroke.ts         — pointer events → InkAnnotation stroke points
exportAnnotatedPdf.ts   — pdf-lib export
```

### `apps/web/src/components/pdf-preview/index.tsx` (existing)

- Mount `<AnnotationLayer>` and `<InkCanvas>` as siblings to the pdfjs canvases.
- Show `<AnnotationToolbar>` in the viewer header.
- Add "Export annotated PDF" button that calls `exportAnnotatedPdf`.

### `apps/web/src/dialogs/pdf-preview-dialog.tsx` (existing)

- Pass `editor` and `attachmentHash` into `PdfPreview`.

---

## Implementation Steps

### Step 1 — Types and editor commands

1. Add `PdfAnnotation` union and `PdfRect` to
   `packages/editor/src/extensions/attachment/types.ts`.
2. Add `annotations` attribute to the attachment Tiptap node.
3. Add `addPdfAnnotation`, `updatePdfAnnotation`, `removePdfAnnotation` commands,
   each taking `(attachmentHash: string, annotation: PdfAnnotation)`.

### Step 2 — Text selection bridge

1. Create `useTextSelection.ts` in the pdf-preview component directory.
2. After `textlayerrendered`, listen on `mouseup`.
3. Read `window.getSelection()`, compute `PdfRect[]` by dividing viewport
   coordinates by `viewport.scale` and flipping the Y axis to PDF-space.
4. Expose `{ selectedText, rects, page, clear }`.

### Step 3 — Annotation layer

1. Create `AnnotationLayer.tsx` accepting `annotations`, `pageIndex`, `viewport`.
2. Render a `<svg>` with each annotation mapped to its SVG representation.
3. Sticky note anchors open `<StickyNote>` on click.

### Step 4 — Ink input

1. Create `useInkStroke.ts`: capture `pointerdown/move/up` on the ink canvas,
   feed to `perfect-freehand`, return finalised stroke points in PDF-space on
   completion.
2. Create `InkCanvas.tsx`: transparent `<canvas>` that is active only when the
   toolbar is in ink mode; draws the live stroke preview; commits on finish.

### Step 5 — Annotation toolbar

1. Create `AnnotationToolbar.tsx` with mode buttons (highlight, underline, ink,
   area, sticky) and a colour picker row.
2. Text-selection toolbar floats near the selection; general toolbar sits in the
   viewer header.

### Step 6 — Sticky note popover

1. Create `StickyNote.tsx` — `<textarea>` popover anchored to the sticky
   position; saves on blur; removes the annotation when cleared.

### Step 7 — Wire up in dialog

1. Thread `editor` and `attachmentHash` from `pdf-preview-dialog.tsx` into
   `PdfPreview`.
2. `useAnnotations` reads the current annotation array from the attachment node
   and exposes the three editor commands.

### Step 8 — Export

1. Add `pdf-lib` dependency to `apps/web`.
2. Implement `exportAnnotatedPdf.ts` as described above.
3. Wire "Export annotated PDF" button in the viewer toolbar.

### Step 9 — Tests

- **Unit (Vitest):** `addPdfAnnotation` and `removePdfAnnotation` commands —
  verify annotation array on attachment node attribute updates correctly for
  each annotation type.
- **E2e (Playwright):** open a PDF attachment, create a text highlight, reload,
  assert highlight is rendered. Create an ink stroke, reload, assert it persists.
- **Export smoke test:** trigger export, assert download fires and the resulting
  blob is a valid PDF (check magic bytes `%PDF`).

---

## Commit & Contribution Guidelines

Follow the project's commit scopes exactly:

```
editor: add PdfAnnotation types, annotations attribute, and commands
web: add PDF annotation layer, ink canvas, and toolbar
web: add export-to-annotated-PDF using pdf-lib
docs: update PDF annotation plan with freehand and export
```

All commits signed with DCO:

```
Signed-off-by: Tuuuni <tuuuni@outlook.com>
```

Open a GitHub issue before starting coding work, reference it in the PR, and
run the full bootstrap + lint + prettier + test cycle before opening the pull
request.

---

## Open Questions

1. **Sync conflict resolution.** The current last-write-wins strategy works for
   v1. A per-annotation merge (by `id`) would prevent two devices from clobbering
   each other's work. Worth raising in the issue before merging.

2. **Mobile annotation UI.** The data model is shared. The SVG overlay can be
   ported to React Native using `react-native-svg`. Ink input via touch is a
   separate, non-trivial UX problem — scope as a follow-up issue.

3. **Ink stroke storage size.** Dense freehand strokes can generate many points.
   Apply Ramer–Douglas–Peucker simplification (ε ≈ 0.5 pt) before storing to
   cap point counts without visible quality loss.

4. **Annotation sidebar.** A panel listing all annotations with jump-to-page
   links would improve navigation on heavily annotated documents. Out of scope
   for v1.
