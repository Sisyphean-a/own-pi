import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";

import { installThinkingCollapse, syncThinkingLabel, toggleThinking } from "../src/display/message-display.ts";

initTheme("dark");

function makeComponent() {
  return new AssistantMessageComponent();
}

function show(component: AssistantMessageComponent, content: object[], isStreaming: boolean): string {
  component.updateContent({ role: "assistant", content } as never, isStreaming);
  return component.render(80).join("\n");
}

test("shows only the current streaming thinking and hides it as soon as text or a tool follows", () => {
  installThinkingCollapse();
  const component = makeComponent();
  const thinking = { type: "thinking", thinking: "live reasoning" };
  const content: object[] = [thinking];

  assert.match(show(component, content, true), /live reasoning/);
  content.push({ type: "text", text: "answer starts" });
  const textOutput = show(component, content, true);
  assert.doesNotMatch(textOutput, /live reasoning|Thinking\.\.\./);
  assert.match(textOutput, /answer starts/);

  content.push({ type: "thinking", thinking: "new reasoning" });
  const nextOutput = show(component, content, true);
  assert.match(nextOutput, /new reasoning/);
  assert.doesNotMatch(nextOutput, /live reasoning/);
  assert.doesNotMatch(show(component, content, false), /new reasoning|Thinking\.\.\./);
  const nextMessage = makeComponent();
  assert.match(show(nextMessage, [{ type: "thinking", thinking: "next turn" }], true), /next turn/);
  assert.doesNotMatch(component.render(80).join("\n"), /reasoning|Thinking\.\.\./);

  const toolComponent = makeComponent();
  assert.match(show(toolComponent, [{ type: "thinking", thinking: "before tool" }], true), /before tool/);
  const toolOutput = show(toolComponent, [
    { type: "thinking", thinking: "before tool" },
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
  ], true);
  assert.doesNotMatch(toolOutput, /before tool|Thinking\.\.\./);
  assert.equal((toolComponent as never as { lastMessage: { content: object[] } }).lastMessage.content.length, 2);
});

test("shortcut can reveal hidden thinking and restore automatic visibility", () => {
  installThinkingCollapse();
  const component = makeComponent();
  const ctx = { ui: { setHiddenThinkingLabel(label = "Thinking...") { component.setHiddenThinkingLabel(label); } } };
  syncThinkingLabel(ctx);
  const content = [
    { type: "thinking", thinking: "earlier reasoning" },
    { type: "text", text: "answer" },
  ];
  assert.doesNotMatch(show(component, content, false), /earlier reasoning|Thinking\.\.\./);
  toggleThinking(ctx);
  assert.match(component.render(80).join("\n"), /earlier reasoning/);
  toggleThinking(ctx);
  assert.doesNotMatch(component.render(80).join("\n"), /earlier reasoning|Thinking\.\.\./);
});
