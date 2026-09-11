@api
Feature: L — Configuration, limits and errors
  As a person who did not read the configuration section
  I want the app to work with no configuration and to enforce the limits it advertises
  So that nothing surprising happens later

  Scenario: L1 — Everything has a working default
    Given no configuration at all
    When the server starts
    Then it starts, selects the local provider and reports the limits it enforces

  Scenario: L2 — Port precedence and the development proxy
    Given a port of zero
    When the server starts
    Then it reports the port it was actually given

  Scenario: L3 — Errors have one consistent shape
    When failures are produced on several routes
    Then each carries a message, a code, a retryable flag and where relevant a provider

  Scenario: L4 — The advertised limits are real
    When I walk up to the prompt length limit and one step past it
    Then the boundary is accepted and the step past it is refused with the limit named
    When I walk up to the library cap and one step past it
    Then the cap holds
