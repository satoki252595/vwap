{
  description = "日本株 VWAP + 価格別出来高 (Yahoo Finance → GitHub Pages)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        py = pkgs.python3.withPackages (ps: [ ps.yfinance ps.xlrd ]);
      in {
        devShells.default = pkgs.mkShell {
          packages = [ py pkgs.git ];
          shellHook = ''
            echo "vwap devShell"
            echo "  収集:   python scripts/fetch_vwap.py"
            echo "  配信:   python -m http.server -d docs 8000  → http://localhost:8000"
          '';
        };
      });
}
