Feature: M — Marking a rewrite and fixing it again
  As a person reading a rewrite that is nearly right
  I want to point at the parts I loved and the parts I did not
  So that the next rewrite keeps the first and changes the second without my starting over

  Background:
    Given PromptFixer is running against a scripted model
    And the blog prompt has been fixed once, giving a rewrite I can mark

  @api
  Scenario: M1 — The model is shown what I marked, and the result says how many marks it was given
    Given I marked one passage of the rewrite to keep and one to change
    When I fix again with my marks
    Then the model was shown the rewrite I marked and both passages, each under its own verdict
    And it was still asked to fix my original prompt, with the same findings as before
    And the new rewrite has the kept passage word for word and no longer has the other as it was
    And the run details say one kept passage and one passage to change were applied, and none ignored
    And the before score is still the score of my original prompt
    Given a rewrite in which two words of the sentence I kept stand once more, on their own, and there I marked them to change
    When I fix again with my marks
    Then the model is shown both marks, and told that inside the kept sentence the kept sentence wins
    And a rewrite that rewords those words where they stood alone is accepted at the first attempt, with no warning

  @api
  Scenario: M2 — A rewrite that drops a passage I kept is retried, and the faithful attempt is kept
    Given the model first paraphrases the passage I kept and leaves the other as it was, then follows my marks
    When I fix again with my marks
    Then I receive the attempt that follows them, with no warning
    And the run details show two attempts
    And the retry was told which passage it had dropped and which it had left as it was, each under its own verdict
    And it was shown my marks again

  @api @browser
  Scenario: M3 — When the model ignores my marks twice, I still get a result and I am told what was not honoured
    Given the model ignores my marks on both attempts
    When I fix again with my marks
    Then I still receive a rewrite
    And a warning says how many kept passages are missing and how many passages to change are still there
    And the run details name those passages
    And in the interface the warning has its own headline, and the refined note claims no mark that was ignored

  @api
  Scenario: M4 — Nonsense marks are coerced, never a server error
    When marks arrive as a string, a number, a list, null, or holding things that are not text
    Then each request succeeds as an ordinary fix and none of them produces a server error
    When every mark points at words that are not in the rewrite
    Then it is an ordinary fix: the model is shown no marks and the result mentions none
    When a passage is marked twice, or padded with spaces, among marks that point at nothing
    Then the model is shown it once, trimmed, and nothing else
    When a passage is marked both to keep and to change, and those words stand in only one place in the rewrite
    Then the change wins
    When the same words stand in two places and are marked both ways
    Then the model is shown both marks, and rewording one of the two places honours both
    When twenty-five passages are marked the same way, or one mark runs to 2,500 characters
    Then the model is shown the first twenty, and the first 2,000 characters, and the result counts twenty
    When the marked rewrite is longer than a prompt may be
    Then it is refused with a message naming the length and the limit

  @api
  Scenario: M5 — A fix without marks is the fix it always was
    When I fix the blog prompt with no marks
    Then the model is shown no earlier rewrite and no marks
    And the result says nothing about marks
    Given I have since fixed again with marks
    When I fix the blog prompt once more with no marks
    Then the earlier marks have no influence on it
    Given a model whose rewrite holds a "<user_feedback>" slot of its own for the prompt's user to fill
    When I fix the blog prompt with no marks
    Then the rewrite comes back with its slot intact, after one attempt and with no warning
    And marking that rewrite and fixing again leaves the slot where it was, again with no warning

  @browser
  Scenario: M6 — I mark what I loved and what I did not
    Given a completed fix on the Fixed tab
    Then both marking buttons are disabled, because nothing is selected
    When I select words outside the rewrite, or drag from outside into it
    Then both buttons stay disabled
    When a selection starts in the rewrite and runs on into a toast
    Then both buttons are disabled
    When a selection of the last line ends where a triple click leaves it, just outside the rewrite
    Then that line can be marked
    When I double-click a word of the rewrite and press "Keep it — I loved it"
    Then that word is highlighted as kept and the selection is gone
    When I drag across a sentence and press "Change it — I didn't like it"
    Then that sentence is highlighted as to change
    And the bar counts one kept and one to change and offers "Fix again with my marks"
    Given a rewrite longer than the window, scrolled until the marking bar is stuck above it
    When I drag a selection upwards from the rewrite onto the bar, from plain text or from a highlight
    Then the selection stays inside the rewrite and both buttons can be pressed
    And the bar takes the mouse again when the press ends, even a press that ends without a mouse-up
    When twenty passages are kept and I select another
    Then "Keep it — I loved it" is disabled and says twenty is the most the model is shown, and the other button is not
    When I remove one highlight
    Then the passage can be kept

  @browser
  Scenario: M7 — A mark can be changed and taken back
    Given a rewrite with two passages kept and one to change
    When I drag across a kept passage again and press "Change it — I didn't like it"
    Then the newer verdict replaces the older one
    When I click a highlighted passage
    Then its highlight is removed and the count follows
    When I press Enter on a highlighted passage from the keyboard
    Then its highlight is removed too
    When I press Ctrl+Enter in the rewrite or on the bar while a mark is showing
    Then no fix is started and the mark is still there
    When I press "Clear marks" from the keyboard
    Then every highlight is gone, and so is the offer to fix again
    And the focus is on the rewrite, which shows no ring, and not at the top of the page
    When I click in the rewrite and press Ctrl+Enter
    Then a fresh fix runs, as it does from anywhere else

  @browser
  Scenario: M8 — "Fix again with my marks" sends exactly what I marked
    Given I kept one passage and marked another to change
    When I press "Fix again with my marks" from the keyboard
    Then the model was shown exactly those two passages and the rewrite they came from
    And I am told it was refined, with the before and after scores
    And the new rewrite joins the history as "2 of 2"
    And the What changed line says it was refined with my marks, one kept and one changed
    And the new rewrite carries no highlights, and the focus is on it, not at the top of the page
    And stepping back to the first rewrite does not bring the old highlights back
    When I mark the first rewrite again and step forward and back through the history
    Then the mark is gone
    When I mark it once more and press "Fix prompt"
    Then the fresh rewrite carries no highlights, and stepping back to the first one does not bring the mark back
    Given the fresh rewrite has two words of the sentence I keep standing once more on their own, and there I mark them to change
    When I press "Fix again with my marks"
    Then the model was shown one passage to keep and one to change, as the bar counted
    And the What changed line says one kept and one changed, with no warning

  @browser
  Scenario: M9 — The rewrite stays exact while marks are showing
    Given highlights of both kinds on the rewrite, one of two lines and one of four lines and more than a hundred characters
    Then the rewrite on screen is still the fixed prompt, character for character
    And each highlight is a button whose name gives a screen reader the verdict and the whole passage, its line breaks as spaces
    When I press Copy
    Then the clipboard holds the fixed prompt, with nothing from the marking bar in it

  @browser
  Scenario: M10 — Marks are readable and fit a small window
    Given a 1024 by 720 window with highlights of both kinds and the count showing
    Then every piece of text, inside both highlight colours and on the bar, meets AA contrast
    And nothing scrolls horizontally and "Fix again with my marks" is on screen

  @browser
  Scenario: M11 — Fixing again still works after I edited the prompt
    Given a completed fix on which I marked a passage
    When I type a character in the editor
    Then the rewrite is parked behind the edited-prompt notice, and there is nothing to fix again with
    When I delete that character again
    Then the rewrite is back with my mark on it
    When I change the text in the editor and press "Show last fix"
    Then the parked rewrite comes back with my mark still on it
    When I press "Fix again with my marks"
    Then the new rewrite is shown, not parked behind the edited-prompt notice
    And the model was asked to refine the prompt that rewrite was made for, not the text now in the editor
    And the editor still holds my edit
