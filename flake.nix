{
  description = "日本株 VWAP + 価格別出来高 (Yahoo Finance → GitHub Pages)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        py = pkgs.python3.withPackages (ps: [ ps.xlrd ]);
      in {
        devShells.default = pkgs.mkShell {
          packages = [ py pkgs.deno pkgs.git ];
          shellHook = ''
            echo "vwap devShell"
            echo "  マスター: python scripts/build_stocks.py"
            echo "  プロキシ: deno run -A proxy/yahoo.ts   (http://localhost:8000)"
            echo "  配信:     python -m http.server -d docs 8200  → http://localhost:8200"
          '';
        };
      });
}
