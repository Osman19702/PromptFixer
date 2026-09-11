Feature: K — The desktop application
  As a person who installed PromptFixer
  I want it to behave like a well-mannered desktop app
  So that installing, quitting and configuring it hold no surprises

  @desktop @nightly
  Scenario: K1 — Install, run, uninstall, reinstall
    Given the built installer on a clean machine
    When I install, run, uninstall and reinstall
    Then the model and the library survive

  @desktop @nightly
  Scenario: K2 — The window opens our interface and nothing else
    When a same-origin navigation occurs
    Then it proceeds
    When a file is dropped, an external link followed, or a lookalike origin navigated to
    Then each is blocked in the window

  @desktop @nightly
  Scenario: K3 — Quitting is deterministic
    Given a loaded model
    When I quit
    Then the quit waits for unload, and a failing or hung unload still quits in bounded time

  @desktop @nightly
  Scenario: K4 — Configuration is read from where the documentation says
    Given the packaged app
    Then the per-user .env overrides the desktop defaults and the working-directory .env is ignored
    Given the app run from source
    Then the project .env wins over the per-user one, and a shell variable wins over both

  @api
  Scenario: K5 — The app finds a free port and its interface finds the app
    When two copies of the server start at once
    Then both get a port and both answer

  @api
  Scenario: K6 — An unknown API route is a not-found, not the application shell
    When I request an API path that does not exist
    Then I get a not-found response, not the interface HTML
