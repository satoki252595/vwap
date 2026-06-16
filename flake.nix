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
          packages = [ py pkgs.nodejs pkgs.git ];
          shellHook = ''
            echo "vwap devShell (Cloudflare Worker + R2)"
            echo "  依存:     npm install            (unpdf + wrangler)"
            echo "  マスター: python scripts/build_stocks.py"
            echo "  開発:     npx wrangler dev       → http://localhost:8787"
            echo "  デプロイ: npx wrangler deploy"
          '';
        };
      });
}
