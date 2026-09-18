import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const files = [
  "自动发邮件/发邮件最终数据.xlsx",
  "自动发邮件/发邮件8.17-1(整理原表).xlsx",
  "8月25多包裹/ShipmentManagement.xlsx",
  "Drop Shipping Order List20260825203710.xlsx",
];

for (const file of files) {
  const input = await FileBlob.load(file);
  const workbook = await SpreadsheetFile.importXlsx(input);
  console.log(`FILE ${file}`);
  console.log((await workbook.inspect({
    kind: "workbook,sheet,table",
    maxChars: 10000,
    tableMaxRows: 8,
    tableMaxCols: 20,
    tableMaxCellChars: 120,
  })).ndjson);
  for (const sheet of workbook.worksheets.items) {
    const preview = await workbook.render({ sheetName: sheet.name, autoCrop: "all", scale: 1, format: "png" });
    const safeName = file.replaceAll("/", "_").replaceAll("\\", "_").replaceAll(".xlsx", "") + `_${sheet.name}.png`;
    await fs.writeFile(`inspect_${safeName}`, new Uint8Array(await preview.arrayBuffer()));
  }
}
