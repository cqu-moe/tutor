import type { Context } from "./types.ts";

export function selectionScope(selection: Context["selection"]) {
  if (!selection) return "";
  const lines = [
    "",
    "Selection scope:",
    `Requested chapter: ${selection.title}`,
    `It starts at heading "${selection.startHeading}" on PDF page ${selection.startPage}.`,
  ];
  if (selection.endHeading === null) {
    lines.push(`It runs through the final PDF page ${selection.endPage}.`);
  } else {
    lines.push(
      `It ends at heading "${selection.endHeading}" on PDF page ${selection.endPage}.`,
      `Boundary page ${selection.endPage} may also contain "${selection.endHeading}" or later content; include that page only when the preceding chapter needs it, and do not cover ${selection.endHeading}.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
