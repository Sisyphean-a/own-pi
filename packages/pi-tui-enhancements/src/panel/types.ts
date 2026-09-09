import type { Combo } from "./combos.ts";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type Skill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
};

export type PickerTab = "skills" | "models" | "combos" | "thinking";

export type PickerResult =
  | { type: "skill"; skill: Skill }
  | { type: "model"; model: Model<Api> }
  | { type: "combo"; combo: Combo }
  | { type: "thinking"; level: ModelThinkingLevel };

export type PickerTheme = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};
