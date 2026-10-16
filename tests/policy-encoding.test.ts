import assert from "node:assert/strict";
import test from "node:test";
import { decodePolicyOriginal, PolicyEncodingError } from "../modules/policy/backend/domain/encoding.ts";
const gbk = Buffer.from("b2c9bff3b7a8b9e6d5fdcec4", "hex");
const page = (declaration: string, body = gbk) =>
  Buffer.concat([Buffer.from(`<html><head>${declaration}</head><body><p>`), body, Buffer.from("</p></body></html>")]);
test("headers, BOM and page declarations retain exact GBK, GB18030 and Unicode text", () => {
  const cases = [
    { bytes: page(""), type: 'text/html; charset="GB2312"', encoding: "gbk", basis: "header", text: "采矿法规正文" },
    { bytes: page('<meta charset="gbk">'), type: "text/html", encoding: "gbk", basis: "declaration", text: "采矿法规正文" },
    {
      bytes: page('<meta http-equiv="Content-Type" content="text/html; charset=GB18030">', Buffer.from("b2c9bff395328236", "hex")),
      type: "text/html",
      encoding: "gb18030",
      basis: "declaration",
      text: "采矿𠀀",
    },
    {
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>矿业文本</p>")]),
      type: "text/html",
      encoding: "utf-8",
      basis: "bom",
      text: "矿业文本",
    },
    {
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>矿业文本</p>", "utf16le")]),
      type: "text/html",
      encoding: "utf-16le",
      basis: "bom",
      text: "矿业文本",
    },
    {
      bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("<p>矿业文本</p>", "utf16le").swap16()]),
      type: "text/html; charset=UTF-16",
      encoding: "utf-16be",
      basis: "header",
      text: "矿业文本",
    },
    { bytes: Buffer.from("<p>未声明但可完整验证的UTF-8文本</p>"), type: null, encoding: "utf-8", basis: "probe", text: "UTF-8文本" },
    { bytes: Buffer.from("<root>Unicode探测</root>", "utf16le").swap16(), type: "application/xml", encoding: "utf-16be", basis: "probe", text: "Unicode探测" },
  ];
  for (const sample of cases) {
    const decoded = decodePolicyOriginal(sample.bytes, sample.type);
    assert.equal(decoded.encoding, sample.encoding);
    assert.equal(decoded.basis, sample.basis);
    assert.ok(decoded.text.includes(sample.text));
  }
  assert.ok(
    decodePolicyOriginal(
      Buffer.concat([Buffer.from('<?xml version="1.0" encoding="GBK"?><root>'), gbk, Buffer.from("</root>")]),
      "application/xml",
    ).text.includes("采矿法规正文"),
  );
});
test("conflicting, unsupported, malformed and unverifiable legacy inputs never silently fall back", () => {
  for (const [bytes, type] of [
    [page('<meta charset="gbk">'), "text/html;charset=utf-8"],
    [page('<meta charset="gbk"><meta charset="utf-8">'), "text/html"],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>x</p>")]), "text/html;charset=gbk"],
    [Buffer.from("<p>x</p>"), "text/html;charset=unsupported-charset"],
    [Buffer.from([0xff]), "text/html;charset=utf-8"],
    [page(""), "text/html"],
    [Buffer.from("<p>文字\0</p>"), "text/html"],
    [Buffer.from("<p>文字�</p>"), "text/html"],
  ] as const)
    assert.throws(() => decodePolicyOriginal(bytes, type), PolicyEncodingError);
});
