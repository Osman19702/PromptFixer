@visual
Feature: N — Looking the same every time
  As a developer changing PromptFixer's interface
  I want one command to tell me which screens look different, and which element changed
  So that a change to the look is something I approve, never something a user finds

  Background:
    Given the built app, served against a scripted model
    And every screen has been captured and approved as a picture, at the desktop and the small window size

  Scenario: N1 — Every screen, captured again, matches its approved picture
    When every screen is captured again at both window sizes
    Then the check passes
    And no screen reports a changed, added or removed region at either size

  Scenario: N2 — A rewrite that came back different is reported on the Fixed screen, by name
    Given the model now words one line of the rewrite differently
    When the Fixed, Issues and Changes screens are captured
    Then the check fails
    And the Fixed screen reports a change on that one line and names the rewrite as the element that changed
    And the Issues and Changes screens, which do not show the rewrite, report nothing

  Scenario: N3 — Marks are part of the picture
    When the approved picture of the marked screen is compared with the unmarked one
    Then the difference names the marking bar, its "Clear marks" and "Fix again with my marks" buttons and both highlighted passages
    And each highlighted passage is a reported region
    And nothing in the editor pane, and nothing above the marking bar, is reported
    Given both highlights have lost all their paint, and nothing has moved
    When the marked screen is captured at both window sizes
    Then at each size the check fails and names the two highlighted passages, each with changed pixels behind it, and nothing else
    Given the highlight of a kept passage has lost its green
    When the marked screen is captured
    Then the check fails and names that highlighted passage, and nothing else

  Scenario: N4 — What honestly varies between two runs raises no alarm
    Given a model that takes longer to answer and reports other token counts
    And a server whose calendar is weeks ahead, so a saved prompt carries another date
    When the Fixed, Changes and Library screens are captured
    Then the check passes and no screen reports a region

  Scenario: N5 — A screen with no approved picture, or a changed look, fails the check until I approve it
    Given approved pictures that lack one screen
    And a Fix prompt button that has been restyled
    When I run "npm run visual"
    Then it fails: the screen without a picture is reported as new, and the other names the Fix prompt button
    When I run "npm run visual:approve"
    Then it succeeds
    When I run "npm run visual" again
    Then it passes

  Scenario: N6 — The one command hands back the verdict and leaves nothing running
    When I run "npm run visual" on a screen that has not changed
    Then it exits 0
    When I run it on a screen that has
    Then it exits 1, and a report a CI job can read has been written
    When I mistype the name of a screen
    Then it exits 2 and lists the screens there are
    And after each run the server it started no longer answers and its temporary folders are gone

  Scenario: N7 — Pointed at the wrong place, the check says so and harms nothing
    When the check is run with no server to look at
    Then it stops with an error that says to use "npm run visual"
    Given a PromptFixer that somebody is using, with a prompt saved in its library
    When the check is pointed at it
    Then it stops with an error, and the saved prompt is still there
