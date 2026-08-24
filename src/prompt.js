const END_OF_TEXT = "\u0003";
const BACKSPACE = new Set(["\u007f", "\b"]);

// Reads one secret line without echoing it. Raw mode is required because the
// terminal driver, not Node, echoes typed characters in canonical mode.
export async function readSecret(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const chunks = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
  }

  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  let value = "";
  try {
    read: for await (const chunk of input) {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") break read;
        if (character === END_OF_TEXT) throw new Error("Cancelled");
        if (BACKSPACE.has(character)) { value = value.slice(0, -1); continue; }
        if (character < " ") continue;
        value += character;
      }
    }
  } finally {
    input.setRawMode(Boolean(wasRaw));
    input.pause();
    output.write("\n");
  }
  return value;
}
