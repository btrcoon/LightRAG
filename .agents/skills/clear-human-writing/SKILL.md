---
name: clear-human-writing
description: Edit or rewrite human-facing answers and product or technical documents so they are concise, complete, plain-language, and matched to the audience's tone. Use for any user-facing response or human-facing documentation.
---

# Clear Human Writing

Apply these rules only to text intended for people.

## Preserve meaning

- Use the request, approved facts, and source material as the basis for the edit.
- Keep every requested or decision-critical fact, constraint, warning, citation, code sample, command, path, `path:line`
  reference, test result, and residual risk.
- Preserve fenced code, inline code, JSON, schemas, machine-readable blocks, required headings, exact literals, and
  localized terminology unless the user asks to change them.
- Preserve repository-defined contracts and do not simplify wording in a way that weakens a requirement.
- Do not invent facts, certainty, decisions, or evidence.
- Resolve a contradiction only when one source clearly takes precedence. Otherwise state the conflict briefly.
- Concision means removing waste, not substance. Do not remove information the user requested.

## Match the reader

- Match the source's language, level of formality, directness, and established terminology.
- Include only rules and instructions that apply to the intended reader.
- Assume readers know the standard practices of their role unless the document is for beginners.
- Leave out routine setup, basic tool checks, and standard workflow reminders unless they are project-specific or likely
  to prevent a real mistake.
- Keep agent approval rules, internal tool constraints, and task-specific limits out of general human guidance unless
  the document is specifically about that workflow.
- Use familiar words and complete, natural sentences.
- Keep necessary domain terms. Define them briefly when the intended reader may not know them.
- Preserve intentional brand voice without copying typos, hostility, or accidental ambiguity.

## Keep the tone natural

- Use a calm, matter-of-fact voice.
- Do not make ordinary guidance sound like policy or a formal ruling.
- Avoid calling something "authoritative," "definitive," or "the source of truth" unless that status is explicit and
  important.
- Refer readers to information directly without making unnecessary claims about its status.
- Use instructions when the reader needs to perform a step or follow a real requirement. Describe background information
  and optional future work without ordering the reader.
- Avoid supervisory phrases such as "ensure," "make sure," and "remember to" when a direct statement is enough.
- State paths, defaults, ownership, and other concrete facts plainly.
- When advice depends on context, say when it applies and what makes the choice suitable.
- Match the certainty and authority of the source. Do not strengthen a suggestion into a requirement.

## Remove writing noise

- Remove throat-clearing, recaps, process narration, generic caveats, repetition, hype, self-congratulation, and
  unsolicited advice.
- Remove generic guidance that could be pasted into any answer or document without adding useful context. If it gives
  this reader no concrete fact or useful action, remove it.
- State simple rules with direct verbs. Replace padded constructions such as "should be handled through" or "rather than
  being" with plain words such as "use" or "do not."
- Remove explicit validation such as "you're right," "good point," or "that makes sense" unless an evaluation was
  requested.
- Avoid canned contrasts such as "it's not X, it's Y" and "not only X, but also Y." State the point directly.
- Avoid choppy or slogan-like fragments such as "Short. Clear. Effective."
- Avoid pet words, repeated catchphrases, corporate metaphors, and fashionable filler.
- Do not use "toolkit," "bucket," "ledger," or "fit check" unless the word is literal and necessary in the reader's
  domain.
- Replace ornate or unnecessarily complex wording with simpler wording.
- Let related ideas flow in a longer natural sentence when they belong together and the result remains clear.
- Keep punctuation light. Avoid unnecessary commas, semicolons, em dashes, colons, parentheses, and repeated sentence
  breaks.
- Use headings, bullets, tables, and emphasis only when they improve navigation or comparison.

## Final check

Before returning or saving human-facing text, confirm that it:

1. Answers the actual request or serves the document's stated purpose.
2. Contains only information this reader needs and no rules meant for a different audience.
3. Preserves requested facts, exact artifacts, and repository-defined contracts.
4. Contains no unsupported additions.
5. Uses the expected tone and terminology.
6. Does not claim more certainty or authority than the source supports.
7. Uses instructions only where the reader needs to act and does not repeat routine practices they already know.
8. States concrete facts and simple rules directly without avoidable jargon or distracting punctuation.
9. Contains no section or sentence that can be removed without losing meaning.
