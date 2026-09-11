@api
Feature: G — Providers and privacy
  As a person who may have put an API key in configuration
  I want it used only where I intended and never exposed
  So that switching providers is safe

  Scenario: G1 — The app offers only providers that can actually work
    Given only the OpenAI-compatible endpoint is configured
    When I read the configuration
    Then that provider is marked configured and every other one is not
    And the configured default provider is what the interface selects
    Given nothing at all is configured
    Then the default provider is local

  Scenario: G2 — Keys never reach the browser
    When every route is exercised, including failures
    Then no response body contains the API key

  Scenario: G3 — A client cannot redirect a keyed provider
    Given a request that supplies its own endpoint address for the keyed provider
    When I fix a prompt
    Then the request still goes to the configured endpoint
    Given a request that supplies a non-http address for a key-less endpoint
    Then it is refused

  Scenario: G4 — Model lists are live where possible and honest where not
    Given the provider answers with its model list
    When I ask for models
    Then I get the live list, labelled live
    Given the provider rejects the key
    When I ask for models
    Then I am told the key was rejected, not shown a fallback list
    Given a provider with no key configured
    When I ask for models
    Then I am told the key is missing instead of a guess

  @nightly
  Scenario: G5 — The journey is the same on every provider
    When the same prompt is fixed on the local provider and the compatible one
    Then the shape of the result and the guard behaviour are identical

  Scenario: G6 — The API is reachable only from this machine
    When a request arrives with a foreign origin
    Then it is not granted cross-origin access
    When a request arrives from a localhost origin
    Then it is
