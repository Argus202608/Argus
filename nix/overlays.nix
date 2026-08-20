# nix/overlays.nix — Expose pkgs.argus with a legacy package alias
{ inputs, ... }:
{
  flake.overlays.default = final: _: {
    argus = final.callPackage ./hermes-agent.nix {
      inherit (inputs) uv2nix pyproject-nix pyproject-build-systems;
      npm-lockfile-fix = inputs.npm-lockfile-fix.packages.${final.stdenv.hostPlatform.system}.default;
      rev = inputs.self.rev or null;
    };
    hermes-agent = final.argus;
  };
}
