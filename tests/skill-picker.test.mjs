import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pickerSource = fs.readFileSync(
  new URL("../src/components/CLI/SkillPicker.tsx", import.meta.url),
  "utf8"
);
const stylesSource = fs.readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8"
);
const zhSource = fs.readFileSync(
  new URL("../src/locales/zh-CN.json", import.meta.url),
  "utf8"
);
const enSource = fs.readFileSync(
  new URL("../src/locales/en.json", import.meta.url),
  "utf8"
);

test("skill picker partitions selected skills above available skills", () => {
  assert.match(pickerSource, /export function partitionPickerSkills/);
  assert.match(pickerSource, /skills\.selectedGroup/);
  assert.match(pickerSource, /skills\.availableGroup/);
  assert.match(pickerSource, /skill-picker-group-label/);
  assert.match(
    pickerSource,
    /for \(const id of selectedIds\)[\s\S]*selected\.push\(skill\)/
  );
  assert.match(
    pickerSource,
    /!selectedSet\.has\(skill\.id\) && matches\(skill\)/
  );
});

test("skill picker selected/available group copy exists in locales", () => {
  assert.match(zhSource, /"selectedGroup": "已选择 \{\{count\}\}"/);
  assert.match(zhSource, /"availableGroup": "可添加 \{\{count\}\}"/);
  assert.match(enSource, /"selectedGroup": "Selected \{\{count\}\}"/);
  assert.match(enSource, /"availableGroup": "Available \{\{count\}\}"/);
});

test("skill picker group labels stick while scrolling", () => {
  assert.match(
    stylesSource,
    /\.skill-picker-group-label\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/m
  );
});
