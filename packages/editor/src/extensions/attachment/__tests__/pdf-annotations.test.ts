/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { createEditor } from "../../../../test-utils/index.js";
import { test, expect, describe, beforeEach } from "vitest";
import { AttachmentNode } from "../attachment.js";
import type { PdfAnnotation } from "../types.js";
import { Editor } from "@tiptap/core";

const HASH = "abc123";

const HIGHLIGHT: PdfAnnotation = {
  id: "ann-1",
  type: "highlight",
  page: 0,
  createdAt: 1000,
  updatedAt: 1000,
  color: "yellow",
  rects: [{ x: 10, y: 20, width: 100, height: 15 }],
  selectedText: "hello"
};

function makeEditor() {
  const { editor } = createEditor({
    extensions: {
      attachment: AttachmentNode
    }
  });
  // Insert a bare attachment node directly so we don't need a real db/file
  editor.commands.insertContent({
    type: "attachment",
    attrs: {
      hash: HASH,
      filename: "test.pdf",
      mime: "application/pdf",
      size: 1024,
      annotations: []
    }
  });
  return editor;
}

function annotations(editor: Editor): PdfAnnotation[] {
  let found: PdfAnnotation[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "attachment" && node.attrs.hash === HASH) {
      found = node.attrs.annotations ?? [];
    }
  });
  return found;
}

describe("addPdfAnnotation", () => {
  test("adds an annotation to an empty array", () => {
    const editor = makeEditor();
    editor.commands.addPdfAnnotation(HASH, HIGHLIGHT);
    expect(annotations(editor)).toHaveLength(1);
    expect(annotations(editor)[0].id).toBe("ann-1");
  });

  test("appends when annotations already exist", () => {
    const editor = makeEditor();
    editor.commands.addPdfAnnotation(HASH, HIGHLIGHT);
    editor.commands.addPdfAnnotation(HASH, { ...HIGHLIGHT, id: "ann-2" });
    expect(annotations(editor)).toHaveLength(2);
  });

  test("returns false for unknown hash", () => {
    const editor = makeEditor();
    const result = editor.commands.addPdfAnnotation("nope", HIGHLIGHT);
    expect(result).toBe(false);
  });
});

describe("updatePdfAnnotation", () => {
  test("updates the matching annotation by id", () => {
    const editor = makeEditor();
    editor.commands.addPdfAnnotation(HASH, HIGHLIGHT);
    editor.commands.updatePdfAnnotation(HASH, "ann-1", { color: "blue" });
    expect(annotations(editor)[0].color).toBe("blue");
  });

  test("leaves other annotations untouched", () => {
    const editor = makeEditor();
    editor.commands.addPdfAnnotation(HASH, HIGHLIGHT);
    editor.commands.addPdfAnnotation(HASH, { ...HIGHLIGHT, id: "ann-2", color: "green" });
    editor.commands.updatePdfAnnotation(HASH, "ann-1", { color: "pink" });
    expect(annotations(editor).find((a) => a.id === "ann-2")?.color).toBe("green");
  });

  test("returns false for unknown hash", () => {
    const editor = makeEditor();
    const result = editor.commands.updatePdfAnnotation("nope", "ann-1", {});
    expect(result).toBe(false);
  });
});

describe("removePdfAnnotation", () => {
  test("removes the annotation with matching id", () => {
    const editor = makeEditor();
    editor.commands.addPdfAnnotation(HASH, HIGHLIGHT);
    editor.commands.removePdfAnnotation(HASH, "ann-1");
    expect(annotations(editor)).toHaveLength(0);
  });

  test("only removes the targeted id", () => {
    const editor = makeEditor();
    editor.commands.addPdfAnnotation(HASH, HIGHLIGHT);
    editor.commands.addPdfAnnotation(HASH, { ...HIGHLIGHT, id: "ann-2" });
    editor.commands.removePdfAnnotation(HASH, "ann-1");
    const remaining = annotations(editor);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("ann-2");
  });

  test("returns false for unknown hash", () => {
    const editor = makeEditor();
    const result = editor.commands.removePdfAnnotation("nope", "ann-1");
    expect(result).toBe(false);
  });
});

describe("HTML serialisation", () => {
  test("data-annotations round-trips through renderHTML / parseHTML", () => {
    const editor = makeEditor();
    editor.commands.addPdfAnnotation(HASH, HIGHLIGHT);

    // Get the serialised HTML
    const html = editor.getHTML();
    expect(html).toContain("data-annotations");

    // Re-parse into a fresh editor and check the annotation survives
    const { editor: editor2 } = createEditor({
      initialContent: html,
      extensions: {
        attachment: AttachmentNode
      }
    });
    const roundTripped = annotations(editor2);
    expect(roundTripped).toHaveLength(1);
    expect(roundTripped[0].id).toBe("ann-1");
    expect(roundTripped[0].color).toBe("yellow");
  });

  test("no data-annotations attribute when annotations array is empty", () => {
    const editor = makeEditor();
    const html = editor.getHTML();
    expect(html).not.toContain("data-annotations");
  });
});
