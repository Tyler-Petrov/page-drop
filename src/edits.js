export function applyEdits(source, edits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("Edits must be a non-empty JSON array");
  let output = source;

  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit !== "object") throw new Error(`Edit ${index + 1} must be an object`);
    const { op, old, value = "", expectedMatches } = edit;
    if (!["replace", "replace_all", "delete", "insert_before", "insert_after"].includes(op)) {
      throw new Error(`Edit ${index + 1} has unknown op: ${op}`);
    }
    if (typeof old !== "string" || old.length === 0) throw new Error(`Edit ${index + 1} needs a non-empty old string`);
    if (typeof value !== "string") throw new Error(`Edit ${index + 1} value must be a string`);

    const matches = output.split(old).length - 1;
    const expected = expectedMatches ?? (op === "replace_all" ? Math.max(matches, 1) : 1);
    if (matches !== expected) {
      throw new Error(`Edit ${index + 1} expected ${expected} match${expected === 1 ? "" : "es"} but found ${matches}; nothing was uploaded`);
    }

    if (op === "replace") output = output.replace(old, value);
    if (op === "replace_all") output = output.split(old).join(value);
    if (op === "delete") output = output.replace(old, "");
    if (op === "insert_before") output = output.replace(old, `${value}${old}`);
    if (op === "insert_after") output = output.replace(old, `${old}${value}`);
  }
  return output;
}

export function matchingLines(source, match, context = 2) {
  const lines = source.split("\n");
  const selected = new Set();
  lines.forEach((line, index) => {
    if (line.includes(match)) {
      for (let cursor = Math.max(0, index - context); cursor <= Math.min(lines.length - 1, index + context); cursor += 1) selected.add(cursor);
    }
  });
  if (selected.size === 0) throw new Error(`No lines contain: ${match}`);
  return [...selected].map((index) => `${String(index + 1).padStart(5)} | ${lines[index]}`).join("\n");
}
