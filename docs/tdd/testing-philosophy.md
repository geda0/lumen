# Testing philosophy

What to test, and where. Adapt the specifics to your stack; the principles are
constant.

## Test the contract, not the implementation
Assert observable behavior — return values, raised errors, externally visible
effects, what a user sees — never private functions, internal state, or which
mock was called how many times. Implementation-coupled tests pass meaninglessly
and block refactoring. The critic flags them.

## The pyramid (most tests at the bottom)
- **Unit / contract (many):** fast, pure logic and the public interface of a
  module. Most behavior should be pinned here.
- **Component / integration (some):** a unit plus its real collaborators or a
  rendered component driven as a user would drive it.
- **End-to-end (few):** whole-system journeys. Slow and flaky-prone — reserve
  for the few critical paths.

## Layers (only if your project has more than one)
A "layer" in `.claude/tdd.config` is a slice with its own test command and
globs. Choose the layer for a behavior by where its contract lives:
- "Given this input, the function/endpoint returns X" -> the code's own layer.
- "When the user does X, they see Y" -> the UI layer.
- "A user can complete journey Z" -> the e2e layer.
Single-package projects just use the one `app` layer for everything.

## Naming
Name tests by behavior, not number: `rejects empty input`, not `test_3`.

## Triangulation
Making a test pass with a hardcoded constant is a legitimate *step*. The next
test forces you to generalize. Don't leave fakes hardcoded forever — and don't
over-build past the current failing test.

## Invariants
Rules your project must ALWAYS uphold (security, correctness, safety) get proven
by tests, not assumed. List them in `project-invariants.md`; for any new path
that touches one, the test that proves it comes first.
