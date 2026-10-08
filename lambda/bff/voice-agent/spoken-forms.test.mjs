// "Say It As" pronunciations: only what Retell reads uses the spoken form;
// everything people read gets the real word back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileVoiceAgent } from "./index.mjs";
import { resolveSpokenForms, spokenFormsRule, toSpokenText, toWrittenDeep, toWrittenText } from "./spoken-forms.mjs";
import { BUILD, fullAgent, knowledgeBases, workspaceProfile } from "./test-fixtures.mjs";

const CWR = [{ word: "C.W.R.", sayAs: "See Double-You Are" }];

test("only plain-words entries become spoken forms; IPA/CMU entries are left to the pronunciation dictionary", () => {
  const forms = resolveSpokenForms({ configuration: { pronunciationDictionary: [
    { word: "C.W.R.", alphabet: "plain", phoneme: "See Double-You Are" },
    { word: "Nguyen", alphabet: "ipa", phoneme: "wɪn" },
    { word: "", alphabet: "plain", phoneme: "nothing" },
    { word: "Same", alphabet: "plain", phoneme: "same" },
  ] } });
  assert.deepEqual(forms, CWR);
});

test("the acronym is replaced however it's punctuated or spaced, and nowhere inside other words", () => {
  for (const written of ["C.W.R.", "C.W.R", "CWR", "C. W. R.", "cwr"]) {
    assert.equal(toSpokenText(`Thanks for calling ${written} Solutions.`, CWR), "Thanks for calling See Double-You Are Solutions.", written);
  }
  assert.equal(toSpokenText("CWRS and SCWR stay", CWR), "CWRS and SCWR stay");
});

test("transcripts get the real word back, however the spoken form came out", () => {
  for (const spoken of ["See Double-You Are", "see double you are", "See, Double-You, Are", "SEE DOUBLE-YOU ARE"]) {
    assert.equal(toWrittenText(`Thanks for calling ${spoken} Solutions.`, CWR), "Thanks for calling C.W.R. Solutions.", spoken);
  }
  assert.deepEqual(
    toWrittenDeep({ transcript: [{ text: "This is See Double-You Are Solutions" }], summary: "Caller reached See Double-You Are." }, CWR),
    { transcript: [{ text: "This is C.W.R. Solutions" }], summary: "Caller reached C.W.R.." },
  );
});

test("what Retell gets: the greeting and prompt use the spoken form, plus a rule for the word arriving any other way", () => {
  const agent = fullAgent({
    greeting: "Thanks for calling C.W.R. Solutions, how can I help?",
    pronunciationDictionary: [{ id: "p1", word: "C.W.R.", alphabet: "plain", phoneme: "See Double-You Are" }],
  });
  agent.configuration.businessProfile = { ...(agent.configuration.businessProfile ?? {}), businessName: "C.W.R. Solutions" };
  const compiled = compileVoiceAgent({ ...BUILD, agent, profile: workspaceProfile, knowledgeBases });
  const { begin_message: greeting, general_prompt: prompt } = compiled.retell.llm;
  assert.equal(greeting, "Thanks for calling See Double-You Are Solutions, how can I help?");
  assert.ok(!/C\.W\.R\.? Solutions/.test(prompt.split("# SAYING NAMES")[0]), "the prompt body never has the written acronym");
  assert.match(prompt, /# SAYING NAMES\n.*\n- C\.W\.R\. -> See Double-You Are$/);
  // Not a Retell pronunciation-dictionary entry: those only work on some voice models.
  assert.ok(!compiled.retell.agentSettings.pronunciation_dictionary?.length);
  // Our own copy of the configuration keeps the real name.
  assert.match(compiled.canonical.conversation.greeting, /C\.W\.R\. Solutions/);
});

test("without plain-words entries nothing changes", () => {
  assert.equal(spokenFormsRule([]), "");
  assert.equal(toSpokenText("CWR", []), "CWR");
  assert.equal(toWrittenText("See Double-You Are", []), "See Double-You Are");
});

test("the postcall and tools copies match this file", () => {
  const source = readFileSync(new URL("./spoken-forms.mjs", import.meta.url), "utf8");
  for (const copy of ["../../postcall/spoken-forms.mjs", "../../tools/spoken-forms.mjs"]) {
    assert.equal(readFileSync(new URL(copy, import.meta.url), "utf8"), source, copy);
  }
});
