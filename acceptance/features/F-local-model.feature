Feature: F — The local model
  As a person who wants nothing to leave my machine
  I want the built-in model to download, load and run without configuration
  So that the app works offline and I always know its state

  @api
  Scenario: F1 — A first-run user with no model is told exactly what to do
    Given the local provider is selected and no model is on disk
    When I open the app
    Then the status says the model is missing and names it with its size
    And the catalogue shows every tier and whether it is downloaded
    When I press Fix anyway
    Then I am told the model is not downloaded, not a generic failure
    And linting still works

  @nightly
  Scenario: F2 — The download is visible, resumable and cancellable
    When I start the download
    Then I see bytes and a percentage
    When I cancel it
    Then the state is "missing" with no error and the Download button is back
    When I interrupt and restart it
    Then it resumes rather than starting from zero

  @nightly
  Scenario: F3 — A download that produced no usable file says so
    Given a download that completes but leaves a file of the wrong size
    When it finishes
    Then the state is an error with a message, not ready

  @api
  Scenario: F4 — The machine picks a sensible model on its own
    Given an explicit tier "lite" in configuration
    When I open the app
    Then the selected tier is lite regardless of this machine's memory

  @api
  Scenario: F5 — Switching models is safe at any moment
    When I select an unrecognised tier
    Then it is rejected with an explanation
    When I select a valid tier that is not downloaded
    Then the selection applies and the status says it is missing

  @nightly
  Scenario: F6 — Loading is never confused about which model it is loading
    Given a load in flight for one tier
    When a request arrives for a different tier
    Then it is not satisfied by the load in flight

  @nightly
  Scenario: F7 — The GPU is used when it exists and its absence is not a failure
    When the model loads on this machine
    Then the status names the backend, and on CPU the app still works

  @nightly
  Scenario: F8 — A prompt too long for the model is refused with advice, not truncated
    Given a prompt exceeding the model's context
    When I press Fix
    Then I am told it is too long for the local model and offered alternatives before generation starts

  @nightly
  Scenario: F9 — The result is always structurally valid
    When the smallest model generates on a difficult prompt
    Then I get a structured result or a clear error, never a malformed one

  @desktop @nightly
  Scenario: F10 — Quitting releases the model
    Given a loaded model
    When I close the window
    Then the model is unloaded and the process exits within a bounded time

  @manual
  Scenario: F11 — Nothing leaves the machine
    Given the network is physically disconnected
    When I lint, fix, save and export
    Then all four succeed
