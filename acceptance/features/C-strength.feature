@api
Feature: C — The strength contract and the rewrite guard
  As a person who chose how much of my text may change
  I want that choice enforced and explained when the model ignores it
  So that "Light touch" means what it says

  Background:
    Given PromptFixer is running against a scripted model

  Scenario: C1 — Strength is a promise about the user's own words
    When I fix the same prompt at Light touch, Balanced and Full rebuild
    Then the run details state a retention floor of 60%, 30% and none respectively
    And the presets offered to the interface list exactly those three strengths

  Scenario: C2 — A Light touch rewrite that throws the user's words away is retried, and the faithful attempt is kept
    Given the ten-word complaint "I changed the strgnth but it still changes a lot"
    And the model first returns an entirely different prompt, then a faithful typo fix
    When I fix it at Light touch
    Then I receive the faithful edit
    And the run details show two attempts and no warning
    And the retry was told the specific reason the first attempt was rejected

  Scenario: C3 — When both attempts overshoot, the user is warned and still gets the better one
    Given the model returns a different prompt twice
    When I fix the complaint at Light touch
    Then I still receive a rewrite
    And a warning names the strength and the percentage of my words that survived
    And the advice is never the strength I am already on

  Scenario: C4 — Light touch is never asked to do the impossible
    Given a prompt whose findings include missing context, audience, format and limits
    When I fix it at Light touch
    Then the model was shown none of those additive findings
    When I fix it at Balanced
    Then the model was shown them

  Scenario: C5 — Keeping every word and bolting scaffolding onto it is also a violation
    Given the model keeps every word and appends a role line and three sections, twice
    When I fix the complaint at Light touch
    Then it is retried once
    And the warning says the model added too much, not that it removed too much

  Scenario: C6 — Full rebuild is genuinely unbounded
    Given the model returns an entirely different prompt
    When I fix the complaint at Full rebuild
    Then I receive it with no warning of any kind
    And only one attempt was made

  Scenario: C7 — The tool's own instructions never reach the user
    Given the model pastes its instructions after my text, twice
    When I fix the complaint at Light touch
    Then the boilerplate is stripped from the result
    And every line I wrote survives
    And I am warned to check the result carefully
    And the output is never empty

  Scenario: C8 — A user's own finding-shaped text is not mistaken for our boilerplate
    Given my prompt legitimately contains bracketed severity tags like a linter report
    And the model returns it lightly edited
    When I fix it at Light touch
    Then I get my text back with no leak warning

  Scenario: C9 — When two attempts both fall short, the choice between them is predictable
    Given the first attempt diverges and the second leaks instructions
    When I fix at Light touch
    Then the divergent attempt is kept, with a retention warning
    Given the first attempt leaks instructions and the second diverges
    When I fix at Light touch
    Then the divergent attempt is kept, with a retention warning

  Scenario: C10 — A failed corrective retry never becomes a server error
    Given the first attempt overshoots and the retry fails upstream
    When I fix at Light touch
    Then I receive the first attempt
    And the warning also says the retry failed and why
