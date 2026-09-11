@browser
Feature: H — The editor and the results interface
  As a first-time user
  I want the interface to explain itself and never lie about what it is showing
  So that I can trust the score on screen

  Background:
    Given the built app is open in a browser against a scripted model

  Scenario: H1 — The first thirty seconds
    When I open the app for the first time
    Then I see an empty editor with an explanatory placeholder, an example gallery and a sample button
    When I click an example
    Then the prompt, task type and strength are set and the score and issues appear

  Scenario: H2 — All eight built-in examples load and lint
    When I choose each example in turn
    Then the prompt, task type and strength are set and every other option is left alone

  Scenario: H3 — A broken example list is an empty gallery, not a broken app
    Given the examples cannot be fetched
    When I open the app
    Then the gallery is absent and everything else works

  Scenario: H4 — Editing after a fix does the honest thing
    Given a completed fix on screen
    When I edit the prompt
    Then the Issues tab shows the live analysis of the new text and the fix result is parked

  Scenario: H5 — A deliberately pinned older result keeps its tab
    Given I have stepped back to an earlier fix
    When I continue to edit
    Then the pinned result keeps the Issues tab

  Scenario: H6 — Apply and undo
    When I press Apply
    Then the fixed text replaces the editor content, the score re-lints and Undo appears
    When I press Undo
    Then the original text returns and Undo disappears
    When I apply and then edit the applied text
    Then Undo is no longer offered

  Scenario: H7 — Copy puts the rewrite on the clipboard
    When I press Copy
    Then the clipboard holds the fixed prompt exactly as displayed

  Scenario: H8 — Fix is disabled when it cannot succeed, and says why
    Given each of: empty editor, no provider, model missing, download in progress, cancel settling
    Then the Fix button is disabled with a visible reason

  Scenario: H9 — A remembered model choice is reconciled with the server
    Given I previously chose a tier and the server is on another
    When I open the app
    Then my choice is sent to the server, not merely displayed

  Scenario: H10 — Warnings read like sentences a person wrote
    Given each kind of guard warning
    Then the headline matches the kind and an unknown kind shows the raw text

  Scenario: H11 — The app is usable from the keyboard
    When I tab through the interface
    Then every control is reachable in a sensible order
    And Ctrl+Enter runs a fix, Enter on a nested Delete deletes, Escape closes the drawer

  Scenario: H12 — Text meets contrast requirements
    Then every foreground/background pairing meets AA contrast

  Scenario: H13 — The window works at a small size
    Given a 1024 by 720 window
    Then nothing is clipped and no pane scrolls horizontally

  Scenario: H14 — Every action without a visible result reports itself
    When I save, import, export, copy and apply
    Then each shows a confirmation stating the outcome
