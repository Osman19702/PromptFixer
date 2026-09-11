@api
Feature: E — The prompt library
  As a person who fixes prompts regularly
  I want to keep the ones I liked, find them again, and move them between machines
  So that my work is never lost and never silently overwritten

  Background:
    Given PromptFixer is running with a private library

  Scenario: E1 — Save it, find it, reopen it, delete it
    When I save a completed fix
    Then it appears in the library with its scores, provider and model
    When I search for a word from the original
    Then only matching entries are listed
    When I delete it
    Then it is gone immediately

  Scenario: E2 — A hand-edited library file loads anyway
    Given the library file contains a null entry, a number where a string belongs, an entry with no id and one valid entry
    When I open the library
    Then the valid entry is listed and the rest are dropped silently
    Given the library file is not valid JSON at all
    When I open the library
    Then it is empty rather than an error
    And the broken file has been moved aside, not deleted

  Scenario: E3 — A crash during a save cannot corrupt the library
    When twenty saves race each other
    Then the library file is valid JSON at every moment it is read
    And every save is present afterwards
    And no temporary file is left behind

  Scenario: E4 — The library is bounded and drops the oldest first
    Given the library holds 500 entries
    When I save one more
    Then the newest is present, the oldest is gone, and the count is still 500

  Scenario: E5 — A library moves between machines
    When I export the library
    Then I get a JSON file named with today's date
    When I import that file into a library that already has some of the entries
    Then the unknown entries are added and the known ones are skipped, not overwritten
    And malformed entries are dropped
    And the reply counts what was imported and skipped
    When I import the same file again
    Then nothing is added

  Scenario: E6 — Importing the wrong file says so in plain words
    When I import a JSON object that is not a library
    Then I am told what shape was expected
    And the library is unchanged

  Scenario: E7 — The library lives where the documentation says it lives
    Given the data directory override is set
    When I save an entry
    Then the library file is written inside that directory
    And nothing is written to the project's own data folder
