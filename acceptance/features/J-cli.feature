@cli
Feature: J — The CI linter
  As a team keeping prompts in a repository
  I want to gate them in CI with the same rules the app uses
  So that a prompt below the bar cannot be merged

  Background:
    Given a temporary directory of prompt files

  Scenario: J1 — A team can gate its prompts in CI with no server, no model and no key
    When I run the linter over a passing set with a minimum score and a severity threshold
    Then it exits 0
    When I run it over a set containing a vague prompt
    Then it exits 1 and names the offending file

  Scenario: J2 — The gate uses the same rules as the app
    When the same text and task type are scored by the linter and by the app
    Then the score, categories and issues are identical

  Scenario: J3 — Directories are searched the way the documentation says
    Given a tree with .md, .txt and .prompt files and other file types
    When I point the linter at the directory
    Then exactly the three extensions are linted, recursively

  Scenario: J4 — A file can declare its own task type
    Given a file whose first line is the task-type comment
    When it is linted
    Then that task type is used and the comment does not affect the score

  Scenario: J5 — Machine-readable output is machine-readable
    When I run with --json
    Then stdout is exactly one parseable object with every file's score, categories and issues
    When I run with --quiet
    Then only the summary line is printed

  Scenario: J6 — A misconfigured job is distinguishable from failing prompts
    When I run with no paths, an unknown flag, an unknown task type, or a missing path
    Then each exits 2 with usage on stderr
