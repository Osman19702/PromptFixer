@api
Feature: A — Scoring a prompt, with no model involved
  As a person writing prompts
  I want an instant, deterministic score with concrete findings
  So that I can improve a prompt before spending any model time on it

  Background:
    Given PromptFixer is running with no API key configured and no local model on disk

  Scenario: A1 — A pasted prompt is scored before anything is contacted
    When I paste "write a blog post about our new feature, make it good and professional..." into the editor
    Then within a few hundred milliseconds I see a score out of 100 and a letter grade
    And I see five category bars: Clarity, Specificity, Context, Format and limits, Structure
    And I see a non-empty list of issues
    And no request has been made to any provider

  Scenario: A2 — The same prompt always produces the same score
    When the same prompt is analysed twice with the same task type
    Then the score, the category breakdown and the ordered issue list are identical

  Scenario: A3 — Every finding tells the user what to do about it
    When a prompt with several defects is analysed
    Then every issue has a title, a severity, a category and a suggestion
    And issues are ordered from most severe to least

  Scenario: A4 — A small edit never swings the score wildly
    Given a prompt scoring somewhere in the middle
    When I add one neutral word to it
    Then the overall score moves by at most a few points
    And a rewrite that only removes filler words never scores lower than the original

  Scenario: A5 — A broken short prompt scores below a clean short prompt
    Given two prompts of the same length, one clean and one with no verb, format or scope
    When both are scored
    Then the clean one scores materially higher

  Scenario: A6 — The task type changes which findings apply
    Given the code prompt "fix my login function, it breaks sometimes..."
    When it is scored with task type General
    Then the "audience not identified" finding is present
    When it is scored with task type Code and engineering
    Then the "audience not identified" finding is absent
    And the "no length or scope limit" finding is low priority rather than a defect

  Scenario: A7 — Code inside a prompt is not linted as if it were prose
    Given a prompt containing a fenced code block with SHOUTED constants and vague-looking identifiers
    When it is scored
    Then no wording finding cites anything from inside the code
    But the structure rules still see the whole prompt

  Scenario: A8 — A prompt that refers to input it did not attach is a serious finding
    Given "Summarize the customer interview transcript below..." with nothing attached
    When it is scored
    Then there is a high-severity finding that input is referenced but not attached
    And its suggestion tells me to add a delimited block
    Given the same instruction with the material pasted right below it
    When it is scored
    Then the missing-input finding is absent and at most a low structure note remains

  Scenario: A9 — A descriptor-style image prompt is not punished for being one
    Given a comma-separated image prompt
    When it is scored with task type Image
    Then there is no finding for a missing task verb, role or output format

  Scenario: A10 — A good prompt is told what it got right
    Given a well-formed prompt with a role, an output format and a bounded scope
    When it is scored
    Then it is in the A band
    And the panel lists what it does well

  Scenario: A11 — An oversized prompt is refused politely rather than hanging the app
    When a prompt of exactly 60,000 characters is analysed
    Then it returns within the interactive budget
    When a prompt of 60,001 characters is analysed
    Then it is refused with a message naming the length and the limit
    And the fix route refuses it the same way

  Scenario: A12 — An empty editor is an empty state, not an error
    When nothing at all is analysed
    Then the result is an empty state rather than an error or a zero score presented as a judgement
