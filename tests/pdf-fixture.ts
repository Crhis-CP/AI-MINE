/** Synthetic, uncompressed PDF; no copied source documents or external assets. */
export function textPdf(text: string, options: { pages?: number; encrypted?: boolean } = {}): Buffer {
  const lines = [""];
  for (const word of text.trim().split(/\s+/)) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + word.length + 1 > 40) lines.push(word);
    else lines[last] += `${lines[last] ? " " : ""}${word}`;
  }
  const content = `BT /F1 12 Tf 14 TL 40 720 Td ${lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  const kids: string[] = [];
  for (let page = 0; page < (options.pages ?? 1); page++) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  const encryption = objects.length + 1;
  if (options.encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R ${options.encrypted ? `/Encrypt ${encryption} 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, "latin1");
}
