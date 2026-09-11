@library-seam
Feature: I — Showing what changed
  As a person reading a rewrite
  I want to see exactly which words changed
  So that the guard's claims about "how much survived" are verifiable

  Scenario: I1 — The user can see exactly what changed and nothing is hidden
    Given an original and a rewrite
    When I view the diff
    Then removals and additions are distinguishable at word level
    Given identical texts
    Then the diff shows them as identical

  Scenario: I2 — One changed word in a long document is one changed word
    Given a prompt of over a thousand words with a single word inserted
    When I view the diff
    Then exactly one insertion is shown and it renders quickly
    Given thousands of lines with one line changed
    Then the diff finds the one line quickly

  Scenario: I3 — A region too large to align is reported, not hidden
    Given a change too large to align word by word
    When I view the diff
    Then the region is reported as replaced wholesale, not shown as empty
