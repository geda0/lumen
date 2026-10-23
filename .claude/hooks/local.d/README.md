# hooks/local.d - project extension point (yours; never refreshed)

Any `*.sh` here is sourced by `.claude/hooks/lib.sh` AFTER the kit defines
`resolve_layer` + the defaults - so you can override them or add helpers without
editing refreshed kit files. `update` never touches this directory.

Example `.claude/hooks/local.d/overrides.sh`:

    resolve_layer() { ... }          # custom layer resolution
    : "${DEFAULT_TEST_GLOB:=...}"    # tweak a default
