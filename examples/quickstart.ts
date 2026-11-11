// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { Idyl } from "@idyl-sh/sdk";

const idyl = new Idyl({ accessKey: process.env.IDYL_ACCESS_KEY });

const computer = await idyl.computers.create({
  name: "eval",
  image: "python-3.12-ubuntu-24.04",
});

await computer.files.upload("eval.py", await readFile("eval.py"));
const { stdout } = await computer.exec("python3 eval.py");
console.log(stdout);

await computer.delete();
