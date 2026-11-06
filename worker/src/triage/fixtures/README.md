# Triage fixtures: SYNTHETIC data

Every file here was invented to exercise the WP-D triage machinery. No labelled sample was supplied, so
none of this is real mail, real crash reports, or a real project registry. **Passing the evaluation on
this data shows that the code paths work (classify, decide, memory lookup, `needs_human`, per-repo
workspace requests). It does not measure accuracy on real-world input.** Replace these files with a real
labelled sample before reading any number as a quality figure.

| File | Contents |
|---|---|
| `projects.json` | Three invented projects. `shop` has two repos (`shop-web`, `shop-api`); `pulse` and `atlas` have one. |
| `memory-seed.json` | Notes seeded into the in-process memory: open-task notes (duplicates), known-answer notes, and one unreviewed untrusted-origin note. |
| `emails.json` | 87 customer-email examples (59 clear, 28 hard). |
| `crash-reports.json` | 63 crash-report examples (41 clear, 22 hard). |
| `build.ts` | Seeded generator that writes the two example files. Edit it or replace the output; `bun src/triage/fixtures/build.ts` from `worker/`. |

## Example shape

`id`, `inputType` (`email` or `crash_report`), `trust`, `source`, `subject?`, `body`, `difficulty`
(`clear` or `hard`), `hardKind?`, `split` (`dev` or `holdout`), and `expected`:
`classification` (bug, crash, feature, question, noise, security, duplicate), `route`
(`route`, `duplicate`, `known_answer`, `drop_noise`, `needs_human`), `project?`, `repos?`, `noteKey?`
(which seeded memory note a duplicate or known answer should match).

Hard-case kinds: `ambiguous_project`, `repo_unclear`, `low_confidence`, `out_of_scope`, `adversarial`
(instruction injection), `untrusted_security`, `unverified_memory_match`, `non_english`,
`noise_like_real_issue`. Multi-repo cases are the `shop` examples whose expected repos are
`shop-web` and `shop-api`.

## Caveats

- The `dev`/`holdout` split is nominal. The rule baseline and its keyword hints were adjusted while
  looking at all of the data, so the holdout is not a clean generalisation test.
- Clear examples are built from templates, so they share vocabulary with the baseline's keyword lists.
  A real sample will look much less tidy, and the baseline will do worse.
- Trust labels follow Spec C 9a: customer email is `untrusted`, the internal mailbox and the crash
  collector are `trusted`, and a few crash reports are marked `untrusted` to model user-submitted text.
