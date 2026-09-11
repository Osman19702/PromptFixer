@api
Feature: B — Fixing a prompt
  As a person with a weak prompt
  I want the tool to rewrite it and show me exactly what changed and why
  So that I can trust the rewrite instead of taking it on faith

  Background:
    Given PromptFixer is running against a scripted model

  Scenario: B1 — The whole journey, end to end
    Given the blog prompt that scores 60 with eleven issues
    When I fix it at task type Writing and strength Balanced
    Then I receive a rewritten prompt, a one-sentence summary, itemised changes with what and why
    And any assumptions, questions and techniques the model reports
    And a before score and an after score measured with identical settings
    And the run details say which provider and model answered and how long it took

  Scenario: B2 — The rewrite addresses the problems the user was shown
    Given a prompt whose issue list I have read
    When I fix it
    Then the findings the model was given are exactly the findings I was shown

  Scenario: B3 — The tool never invents facts about the user's situation
    Given a prompt that says "our new feature" without naming it
    When the model returns a rewrite containing a marked placeholder
    Then the placeholder is scored as a reminder, not a defect, in the after score
    But the same placeholder in an original prompt is scored as a defect

  Scenario: B4 — Failure has a face
    Given the provider answers with a server error
    When I press Fix
    Then I see one sentence naming the provider
    And no stack trace, raw JSON or HTTP status appears in the message
    And the error says whether retrying is worth it

  Scenario: B5 — A fix can be cancelled and the machine is handed back
    Given the model takes a while to answer
    When I cancel the fix mid-generation
    Then the server abandons its request to the provider
    And no corrective retry is started

  Scenario: B6 — A stalled provider gives up in bounded time
    Given the provider accepts the connection and never sends headers
    When I press Fix
    Then the attempt is abandoned at the timeout and marked retryable
    Given the provider sends headers and then stalls the body
    When I press Fix
    Then the attempt is abandoned at the timeout and marked retryable

  Scenario: B7 — A truncated reply is reported as a truncated reply
    Given the provider stops at its output limit mid-answer
    When I press Fix
    Then I am told the reply was cut off and that retrying may help
    And I am not told the model returned malformed data

  Scenario: B8 — Nonsense from the client is coerced, never a server error
    When options are sent as a string, an array, null, or with unknown extra fields
    Then each request succeeds with defaults or fails with a client error
    And none of them produces a server error

  Scenario: B9 — An empty prompt is refused before any model is contacted
    When I press Fix with only whitespace in the editor
    Then it is refused with an explanation
    And no provider call was made

  @browser
  Scenario: B10 — The last ten fixes stay comparable
    Given I have run twelve fixes in one session
    When I use the previous and next controls
    Then only the ten most recent are reachable
    And the counter reads correctly and clamps at both ends
    And the Fixed, Diff, Issues and Changes tabs all follow the selection together
