@api
Feature: D — Learning from the user's own library
  As a person who has saved rewrites I liked
  I want future fixes to match the amount of change I kept before
  So that the tool adapts to me without any configuration

  Background:
    Given PromptFixer is running against a scripted model
    And the library is empty

  Scenario: D1 — The tool learns how much change this user actually likes
    Given I have saved a rewrite of a similar blog prompt that scored higher than its original
    When I fix a new blog prompt
    Then the model was shown that before/after pair as an example
    And the run details say one example was used

  Scenario: D2 — Only examples worth imitating are used
    Given a saved entry whose rewrite scored no better than its original
    When I fix a similar prompt
    Then that entry was not shown to the model
    Given the prompt I am fixing is itself already in the library with a higher after score
    When I fix it
    Then it was not shown to the model as an example of itself

  Scenario: D3 — The same task type is preferred
    Given two saved entries of equal resemblance, one with task type Writing and one with Code
    When I fix a similar prompt at task type Writing and only one example fits
    Then the Writing entry is the one shown

  Scenario: D4 — The user can turn it off, and it never costs anything
    Given a saved entry that would normally be used
    When I fix a similar prompt with the library toggle off
    Then no examples were shown and the run details say zero were used
    And the lookup made no network request beyond the model call itself

  Scenario: D5 — A retry sees the same examples as the first attempt
    Given a saved entry that will be used
    And the model overshoots on the first attempt
    When I fix at Light touch
    Then both attempts were shown the same example

  Scenario: D6 — A rewrite that parrots an example back is caught
    Given a saved entry that will be used
    And the model returns the example's text as its answer, twice
    When I fix a similar prompt
    Then it is treated as leaked boilerplate rather than returned as my rewrite
