# PDF Annotation in Notesnook — Implementation Plan

## Philosophy & Guiding Principles

Notesnook exists to prove that privacy and convenience are not mutually exclusive.
Any PDF annotation feature must hold to the same bar:

- **Encrypted by default.** Annotations are part of note content. They are
  encrypted client-side with the same XChaCha20-Poly1305 pipeline as all other
  content. The PDF binary on disk is never modified.
- **No new dependencies without justification.** The viewer already uses
  `pdfjs-dist` and `@react-pdf-viewer/*`. Build on what is there.
- **Annotations belong to the note, not the file.** The PDF is an attachment; the
  annotations are note content stored as structured JSON alongside the attachment
  reference. This separates concerns cleanly and keeps the attachment hash stable.
- **Cross-platform from day one.** Web, desktop (Electron), and mobile (React
  Native + `editor-mobile`) must all be considered in the data model even if UI
  work is phased.
- **Minimal surface area.** Implement the smallest set of annotation types that
  covers real use-cases well, rather than a large set implemented poorly.

---

## Scope

### In scope (v1)

| Annotation type | Description |
|---|---|
| Text highlight | Coloured background over a text selection |
| Text underline | Underline mark over a text selection |
| Sticky note / comment | Small pop-up note anchored to a page position |
| Area highlight | Rectangular region highlight on any page |

### Out of scope (v1)

- Freehand / ink annotations
- Embedding annotations back into the PDF binary (export-to-annotated-PDF)
- Mobile annotation UI (data model is shared; touch UI is a follow-up)
- Real-time collaborative annotations

---

## Data Model

Annotations are stored as a typed JSON array, encrypted as part of the note
content. They are never written into the PDF file itself.

```typescript
// packages/core/src/types/pdf-annotation.ts

type AnnotationColor = "yellow" | "green" | "blue" | "pink" | "orange";

interface BaseAnnotation {
  id: string;                // nanoid — stable across devices after sync
  page: number;              // 0-indexed
  createdAt: number;         // unix ms
  updatedAt: number;
  color: AnnotationColor;
}

interface TextAnnotation extends BaseAnnotation {
  type: "highlight" | "underline";
  rects: DOMRectLike[];      // bounding boxes from pdfjs text layer
  selectedText: string;      // plain text of selection
  note?: string;             // optional user comment
}

interface StickyNoteAnnotation extends BaseAnnotation {
  type: "sticky";
  x: number;                 // 0–1, relative to page width
  y: number;                 // 0–1, relative to page height
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

type PdfAnnotation = TextAnnotation | StickyNoteAnnotation | AreaAnnotation;
```

The `DOMRectLike` type mirrors `{ x, y, width, height }` in PDF-space
coordinates (points, not pixels) so the layout survives zoom changes.

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

This keeps annotations co-located with the attachment reference inside the
editor document, so they are encrypted and synced as part of note content with
zero extra infrastructure.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  apps/web/src/components/pdf-preview/                   │
│                                                         │
│  PdfPreview.tsx          ← existing viewer              │
│  AnnotationLayer.tsx     ← NEW: SVG overlay             │
│  AnnotationToolbar.tsx   ← NEW: highlight / note tools  │
│  StickyNote.tsx          ← NEW: comment pop-up          │
│  useAnnotations.ts       ← NEW: state + commands        │
└────────────────────────┬────────────────────────────────┘
                         │ reads/writes via
                         ▼
┌─────────────────────────────────────────────────────────┐
│  packages/editor/src/extensions/attachment/             │
│                                                         │
│  index.ts     ← add `annotations` attribute             │
│  commands.ts  ← addAnnotation / updateAnnotation /      │
│                 removeAnnotation                        │
└─────────────────────────────────────────────────────────┘
                         │ encrypted in
                         ▼
┌─────────────────────────────────────────────────────────┐
│  packages/core  (NoteContent, sync, crypto)             │
│  No changes needed — annotations ride in content JSON   │
└─────────────────────────────────────────────────────────┘
```

### Rendering annotations

PDF.js exposes a text layer that maps text quads to DOM rectangles. For text
selections, obtain `rects` from the text layer after the selection event, then
convert from viewport-space to page-space so the coordinates are
zoom-independent. The `AnnotationLayer` component renders an `<svg>` absolutely
positioned over each page canvas; annotations are `<rect>` or `<path>` elements
inside it.

Sticky notes render as small icon anchors in the SVG; clicking them opens a
`StickyNote` popover.

---

## File & Package Changes

### `packages/editor`

```
src/extensions/attachment/
  index.ts          — add annotations attribute + commands
  types.ts          — add PdfAnnotation types (or import from @notesnook/core)
```

No new packages needed.

### `apps/web/src/components/pdf-preview/`

```
AnnotationLayer.tsx       — SVG overlay, renders all annotation types
AnnotationToolbar.tsx     — toolbar that appears on text selection
StickyNote.tsx            — anchored comment popover
useAnnotations.ts         — hook: read/write annotations via editor commands
useTextSelection.ts       — hook: capture pdfjs text selection + rects
```

### `apps/web/src/components/pdf-preview/index.tsx` (existing)

- Mount `<AnnotationLayer>` as a sibling to the pdfjs page canvases.
- Pass `onTextSelect` callback to pdfjs `textLayer` plugin to capture
  selections.
- Conditionally show `<AnnotationToolbar>` when a selection is active.

### `apps/web/src/dialogs/pdf-preview-dialog.tsx` (existing)

- Pass `editor` and `attachmentId` down to `PdfPreview` so the annotation
  hook can issue editor commands.

---

## Implementation Steps

### Step 1 — Core types

1. Add `PdfAnnotation` union type to `packages/editor/src/extensions/attachment/types.ts`.
2. Add `annotations` attribute to the attachment Tiptap node.
3. Add three editor commands: `addPdfAnnotation`, `updatePdfAnnotation`,
   `removePdfAnnotation` — each takes `(attachmentHash, annotation)`.

### Step 2 — Text selection bridge

1. In `apps/web/src/components/pdf-preview/`, create `useTextSelection.ts`.
2. Listen to the `textlayerrendered` event from pdfjs to get access to the text
   layer DOM.
3. On `mouseup`, read `window.getSelection()`, compute bounding rects in
   page-space (divide viewport rect by `viewport.scale`).
4. Expose `{ selectedText, rects, page, clear }`.

### Step 3 — Annotation layer

1. Create `AnnotationLayer.tsx`.
2. Accept `annotations: PdfAnnotation[]`, `pageIndex: number`, `viewport`.
3. Render an `<svg>` with `pointer-events: none` (except interactive elements)
   absolutely positioned over the page.
4. Map each annotation to the appropriate SVG element:
   - `highlight` → `<rect>` with `fill-opacity: 0.35`
   - `underline` → `<line>` at bottom of each rect
   - `area` → `<rect>` with stroke
   - `sticky` → `<g>` with a small icon; `pointer-events: all` to open popover

### Step 4 — Annotation toolbar

1. Create `AnnotationToolbar.tsx` — a small floating bar with colour swatches
   and annotation type buttons.
2. Shown when `selectedText` is non-empty, positioned near the selection.
3. On "highlight" click: call `addPdfAnnotation` command, then clear selection.

### Step 5 — Sticky note popover

1. Create `StickyNote.tsx` — a small `<textarea>` popover anchored to the
   sticky annotation position.
2. Saves on blur; deletes when text is cleared.

### Step 6 — Wire up in dialog

1. In `pdf-preview-dialog.tsx`, pass the editor instance and current attachment
   hash to `PdfPreview`.
2. `PdfPreview` passes them to `useAnnotations`, which reads from and writes to
   the attachment node's `annotations` attribute.

### Step 7 — Persistence & sync

No extra work: annotations live in the Tiptap document JSON, which is encrypted
and synced by `@notesnook/core` the same way as all note content. Sync conflict
resolution (last-write-wins per annotation `id`) can be handled at the core
level in a follow-up.

### Step 8 — Tests

- Unit tests (Vitest) for `addPdfAnnotation` / `removePdfAnnotation` commands:
  verify the annotation array on the node attribute is updated correctly.
- Playwright e2e: open a PDF attachment, create a highlight, reload, assert the
  highlight is still present.

---

## Commit & Contribution Guidelines

Follow the project's commit scopes exactly:

```
editor: add annotations attribute and commands to attachment node
web: implement PDF annotation layer and toolbar
docs: add PDF annotation plan
```

All commits signed with DCO:

```
Signed-off-by: Tuuuni <tuuuni@outlook.com>
```

Open a GitHub issue before starting coding work, reference it in the PR,
and run the full bootstrap + lint + prettier + test cycle before opening
the pull request.

---

## Open Questions

1. **Conflict resolution on sync.** The current `last-write-wins` sync strategy
   works for notes. For annotations it may be acceptable for v1, but a
   per-annotation merge (by `id`) would prevent two devices from wiping each
   other's work. Worth discussing in the issue before merging.

2. **Mobile annotation UI.** The data model is shared. The annotation layer
   could be implemented for `editor-mobile` using a React Native `<Svg>` overlay
   from `react-native-svg`. Touch-based selection is a separate, non-trivial UX
   problem — scope it as a follow-up issue.

3. **Export annotated PDF.** Users may want to share a PDF with annotations
   baked in. `pdf-lib` can draw rectangles and text over pages. This is additive
   and can be a separate issue.

4. **Annotation sidebar / list view.** A panel listing all annotations with
   jump-to-page links would improve navigation for heavily annotated documents.
   Out of scope for v1 but worth noting.
