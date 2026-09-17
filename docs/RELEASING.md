# Releasing

PromptFixer is never published to npm (`"private": true`); what it releases is the Windows
installer. A release is cut by pushing a tag. The `Release` workflow checks that the tag,
`package.json`, `package-lock.json` and `CHANGELOG.md` agree, runs the typecheck, the build and the
unit and component tests, builds the installer, writes `SHA256SUMS.txt` and puts all of it on a
**draft** GitHub release whose notes are the version's changelog section. The draft is published
by hand, after the download has been checked, because the installer is not code-signed.

The version lives in `package.json` and nowhere else. `package-lock.json` repeats it because npm
writes it there, the installer's file name and `GET /api/health` read it, and
`npm run check:release` fails when anything else has a copy. Nothing ships without its changelog
entry: the same check wants a dated section for exactly that version.

## Every release

1. Move the entries under "Unreleased" in `CHANGELOG.md` into a new `## [x.y.z] - YYYY-MM-DD`
   section, add `[x.y.z]: …/compare/v<previous>...vx.y.z` at the bottom and point the
   `[Unreleased]` link at `…/compare/vx.y.z...HEAD`. Entries say what changed for the person
   using the app, the API or the repository, and why; they are not commit subjects. Links to
   files in the repository stay relative (`docs/RELEASING.md`); the workflow makes them absolute
   for the release page, where a relative link answers 404.
2. Bump the version (no tag yet): `npm version x.y.z --no-git-tag-version`. It writes
   `package.json` and both places in `package-lock.json`. See
   [Choosing the number](#choosing-the-number).
3. `npm run typecheck && npm run build && npm run test:all && npm run check:release -- --tag vx.y.z`.
   `test:all` needs the build and takes a few minutes, about four of them in the acceptance
   suite. CI runs that suite again on the pushed commit (step 5); the Release workflow does not
   repeat it (its header says why). No automated run covers a real model — those scenarios are the
   `todo` rows of `npm run test:trace` — so open the app (`npm run desktop:dev`) and, with the
   local model, fix one prompt, mark the rewrite and fix it again.

   `--tag` needs no tag to exist: it is a name to compare with `package.json`. With it the check
   also refuses entries that are still under "Unreleased", and it is then exactly what the
   workflow runs first. Without it, an entry added late and not moved would only be found after
   the tag is public.
4. Commit and push: `git commit -am "release: x.y.z" && git push`.
5. Wait for CI on that commit (`gh run watch`, or the Actions tab). Every push starts it
   (`.github/workflows/ci.yml`): one job repeats the check, the typecheck, the build and the unit
   and component tests, another runs the acceptance suite and the traceability check, and a third
   compares every screen with the commit before, all on a Windows runner. A release commit that is
   red there is not tagged. The third job is not red for a difference, so read its summary page:
   it is the list of what this release does to the interface, and the `elastishot-report` artifact
   has the pictures.
6. Rehearse on the runner: `gh workflow run release.yml --ref master` (or the branch the release
   commit is on), then `gh run watch`. Started by hand, the workflow does everything it will do for the tag — the same check,
   `npm ci`, the typecheck, the build, the tests, the installer, the checksums, the notes — on the
   same Windows runner, but it looks at no release and creates none. The notes appear on the
   run's summary page, and the installer is kept for three days as the run's artifact
   (`gh run download <run id> -n PromptFixer-vx.y.z-rehearsal`). CI has already put `npm ci` and
   the tests on a runner; electron-builder, the checksums and the notes are what only this
   workflow does there, so without this step the pushed tag is the first time they meet one, and
   a failure there means moving a public tag. A patch release
   that changes no dependency, nothing under `build` in `package.json` and nothing in the workflow
   may skip it. GitHub offers a workflow for a manual run only once the file is on the default
   branch.
7. Tag and push the tag: `git tag -a vx.y.z -m "PromptFixer x.y.z" && git push origin vx.y.z`.
8. Watch the Release workflow (`gh run watch`, or the Actions tab). Its first check refuses a tag
   that does not match `package.json`; the installer build is the long part.
9. Verify the draft. Download its three files into an empty folder and check them, then install
   that very file, open it and fix one prompt with the local model:

   ```bash
   gh release download vx.y.z --dir ../promptfixer-vx.y.z
   npm run release:checksums -- --dir ../promptfixer-vx.y.z --check
   git rev-parse "vx.y.z^{commit}"
   ```

   `SHA256SUMS.txt: OK` means the installer and its `.blockmap` are the files the workflow
   hashed. The last line of the draft's notes names the commit the installer was built from; it
   has to be the one `git rev-parse` prints. Leave that line in when editing the notes: the
   workflow reads it back to tell a draft of this commit from a draft of an earlier one.
   Installing over the previous version is the upgrade everybody else will do: the library and
   the model must still be there afterwards.
10. Publish the draft: `gh release edit vx.y.z --draft=false`, or **Publish release** on its page.
11. Then, and only then, point the documentation at it: the link, the size and the SHA-256 in the
    README's "Download (Windows)" block and in `docs/INSTALL.md`, and `docs/releases/vx.y.z.md`
    in the shape of the one before it. If that page went in with the release commit, its size
    and hash read `TBD` until now. The size is in MiB everywhere (bytes / 1,048,576, which is
    also what the workflow's notes say). Commit as `docs: x.y.z download`. The download button on
    osmanturalioglu.com lives in another repository and wants the same link.

    This comes last because the hash does not exist before the build, and the build is of the
    tagged commit: the commit that quotes the hash can never be the commit that was built. The
    download links also answer 404 until the draft is published. So the README inside a tag
    always points at the release before it, and that is expected.

## Building the installer locally

To try an installer before tagging, or when the workflow cannot be used:

```bash
npm run dist:win -- --publish never
npm run release:checksums
```

The first writes `release/PromptFixer-x.y.z-win-x64.exe` and its `.blockmap`; the version in the
name is `package.json`'s, so bump first. `--publish never` keeps electron-builder from uploading
anything on its own: `package.json` has a `build.publish` block, and creating the release is this
checklist's job, after the checksums exist. The second writes `release/SHA256SUMS.txt` over every
`PromptFixer-*` installer in the folder. `release/` is git-ignored and keeps what earlier builds
left there, so move older versions out first if the file is going onto a release.

A build inside a synced folder (OneDrive, Dropbox) can fail with
`EPERM … rename 'release\win-unpacked.tmp'`; the README's
[Troubleshooting](../README.md#troubleshooting) has the cause and the command that builds to an
unsynced folder instead.

Two builds of the same commit are not byte-identical, so a local installer never has the hash of
the workflow's. The hash that counts is the one on the release.

## Choosing the number

[Semantic Versioning](https://semver.org/), as applied here while the version starts with 0:

- **Patch** (`0.2.0` → `0.2.1`): fixes only. Nothing new to learn, nothing in the `/api` contract
  or in `library.json` changes shape.
- **Minor** (`0.2.0` → `0.3.0`): a new feature, or any change to the `/api` contract or to the
  shape of `library.json` that stays backwards compatible: a new route, a new optional request
  field (`feedback` in 0.2.0), a new response field (`meta.feedback`), a new value of an existing
  field (`meta.warningKind: "feedback"`), a new optional field on a library entry that older
  entries simply lack. A linter rule that is added or reworked is a minor too: it moves the
  score of a prompt nobody touched, and `npm run lint:prompts -- --min-score` gates CI on that.
- **Breaking** is anything that makes something that worked stop working without the user
  changing it: removing or renaming an `/api` route or field, changing a field's type or meaning,
  making an optional field required; a `library.json` or library export that the previous version
  wrote and this one cannot read (the envelope's own `"version": 1` would have to become 2, with
  a migration); moving where the library, the model or `.env` live; renaming a `PROMPTFIXER_*`
  variable; changing the flags or exit codes of `npm run lint:prompts`. Semantic Versioning
  allows anything in 0.x, but here a breaking change bumps the minor, never the patch, and its
  changelog entry starts with **Breaking:** and says what to do about it. `1.0.0` is the
  release that declares the `/api` contract and the library shape stable; from then on a
  breaking change is a major.

Changes to documentation, tests or tooling alone need no release: nothing a user installs is
different. They wait under "Unreleased" for the next one.

A pre-release (`0.3.0-rc.1`, an installer for somebody to try before `0.3.0`) takes the same
steps with that version everywhere: in `package.json`, as a dated `## [0.3.0-rc.1]` section, as
the tag `v0.3.0-rc.1`. The workflow marks a version with a `-` in it as a pre-release on GitHub,
so publishing it never makes it the "Latest" release, and step 11 is left out: the README keeps
pointing at the last full release. To see the workflow run, a rehearsal (step 6) is enough; a
pre-release is for handing out an installer.

## If it fails

A failed run publishes nothing. The release is created in the workflow's last step, and as a
draft.

- **Nothing was wrong with the code** (a download timed out, the runner died): re-run the job
  from the Actions tab. A re-run is safe. With no release for the tag it builds and creates the
  draft. With a release that has the installer, its `.blockmap` and `SHA256SUMS.txt`, built from
  the commit the tag points at, it builds nothing. With a draft that is missing one of them it
  builds again and replaces all three and the notes, so the checksums always describe the files
  next to them.
- **The check refused the tag.** It prints one line per problem, the same lines as
  `npm run check:release -- --tag vx.y.z` locally. Fix them, commit, then move the tag.
- **Something has to change** (a test that fails on the runner, a broken build): fix it on the
  branch, delete the tag locally and remotely, and tag the new commit:
  `git tag -d vx.y.z && git push origin :refs/tags/vx.y.z`, then step 7 again. A tag may move
  only while its release is unpublished. A draft that an earlier run left behind does not have
  to be deleted first: its notes name the commit it was built from, and the new run, finding
  another commit there, builds again and replaces the installer, the `.blockmap`,
  `SHA256SUMS.txt` and the notes. Do not re-run the earlier run instead. It would build the
  commit the tag pointed at back then, so it stops as soon as it sees that the tag has moved.
- **The draft is wrong** (the hash check fails, the installer does not start): delete the draft
  with `gh release delete vx.y.z --yes` (the tag stays), then proceed as above.
- **The workflow cannot be used at all**: build locally (above), then create the draft by hand
  and carry on from step 9:

  ```bash
  node scripts/changelog-section.mjs x.y.z --links https://github.com/Osman19702/PromptFixer/blob/vx.y.z > release/RELEASE_NOTES.md
  gh release create vx.y.z --draft --verify-tag --title "PromptFixer x.y.z" --notes-file release/RELEASE_NOTES.md release/PromptFixer-x.y.z-win-x64.exe release/PromptFixer-x.y.z-win-x64.exe.blockmap release/SHA256SUMS.txt
  ```

  Add `--prerelease` for a pre-release. If the workflow later runs for this tag after all, it
  treats a draft whose notes name no commit as not its own and replaces the files.
- **A published release is wrong.** Do not replace its files and do not move its tag: people
  have the installer, and its hash is quoted in the README. Fix forward with the next patch
  version. The workflow holds the same line: it never changes a published release, and it fails
  when the tag of one it built no longer points at the commit named in the notes.
