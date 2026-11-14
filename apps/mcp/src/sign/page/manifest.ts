// Wallet manifest for NEAR Connect, copied from the Noa Market frontend (src/lib/near/manifest.ts),
// trimmed to Intear, Meteor (extension, in-app browser and mobile deep link) and HOT Wallet.
// Executors are self-hosted under /public/wallets/ (see static/wallets/SOURCES.md); near-connect caches
// executor code in IndexedDB keyed by `${id}:${version}`, so bump `version` when a file changes.
export const WALLET_MANIFEST = {
    version: "1.2.0",
    wallets: [
        {
            id: "intear-wallet",
            name: "Intear Wallet",
            icon: "https://storage.herewallet.app/upload/3f24b26bb142cd65ee694b78f8b3004976ebd97d9fc82f4c07d99b27bc124672.png",
            description: "A fast and secure wallet for everyday interactions with dapps",
            website: "https://intea.rs/",
            version: "1.0.0",
            executor: "https://wallet.intear.tech/near-selector.js",
            type: "sandbox",
            features: {
                signMessage: true,
                signTransaction: false,
                signAndSendTransaction: true,
                signAndSendTransactions: true,
                signInWithoutAddKey: true,
                verifyOwner: false,
                testnet: true,
                signDelegateActions: true,
                signInAndSignMessage: true,
                signInWithFunctionCallKey: true
            },
            platform: {
                web: "https://wallet.intear.tech"
            },
            permissions: {
                storage: true,
                location: true,
                allowsOpen: [
                    "https://wallet.intear.tech",
                    "https://staging.wallet.intear.tech",
                    "http://intearwallet.local",
                    "https://intearwallet.local",
                    "http://intearwallet.localhost:3000",
                    "intear://",
                    "https://logout-bridge-service.intear.tech"
                ]
            }
        },
        {
            id: "meteor-wallet",
            name: "Meteor Wallet",
            icon: "https://storage.herewallet.app/upload/9c3981ca59212248e09d37011c07492bf1e19d7d55b9210213af3be6079a05ae.svg",
            description: "The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",
            website: "https://meteorwallet.app/",
            version: "1.1.1",
            // Meteor's own executor (Meteor-Wallet/meteor_wallet_sdk, see SOURCES.md). It talks to the
            // Meteor extension / in-app browser through window.meteorCom(V2) — only reachable from the
            // sandbox when listed in `external` — and deep-links the mobile app (meteorwallet://).
            // Without these it can only open the web wallet.
            executor: "/public/wallets/meteor.js",
            type: "sandbox",

            features: {
                signMessage: true,
                signInWithoutAddKey: true,
                signInAndSignMessage: true,
                signAndSendTransaction: true,
                signAndSendTransactions: true,
                signInWithFunctionCallKey: true,
                signDelegateActions: true,
                mainnet: true,
                testnet: true
            },

            platform: {
                web: "https://wallet.meteorwallet.app",
                chrome: "https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",
                android: "https://play.google.com/store/apps/details?id=app.meteorwallet.v2",
                ios: "https://apps.apple.com/us/app/meteor-wallet/id6739558223"
            },

            permissions: {
                storage: true,
                allowsOpen: [
                    "https://chromewebstore.google.com",
                    "https://wallet.meteorwallet.app",
                    "https://meteorwallet.app",
                    "meteorwallet://"
                ],
                external: ["meteorCom", "meteorComV2"]
            }
        },
        {
            id: "hot-wallet",
            name: "HOT Wallet",
            icon: "https://app.hot-labs.org/images/hot/hot-icon.png",
            description: "Secure Multichain wallet. Manage assets, refuel gas, and mine $HOT on any device with HOT Wallet",
            website: "https://hot-labs.org/wallet",
            version: "1.0.2",
            executor: "/public/wallets/hotwallet.js",
            type: "sandbox",

            platform: {
                android: "https://play.google.com/store/apps/details?id=app.herewallet.hot&hl=en",
                ios: "https://apps.apple.com/us/app/hot-wallet/id6740916148",
                chrome: "https://chromewebstore.google.com/detail/hot-wallet/mpeengabcnhhjjgleiodimegnkpcenbk",
                firefox: "https://addons.mozilla.org/en-US/firefox/addon/hot-wallet",
                tga: "https://t.me/hot_wallet/app"
            },

            features: {
                signMessage: true,
                signInWithoutAddKey: true,
                signAndSendTransaction: true,
                signAndSendTransactions: true,
                // Not in Noa's copy: near-connect hides wallets without testnet:true on testnet.
                testnet: true,
                mainnet: true
            },

            permissions: {
                storage: true,
                allowsOpen: [
                    "https://download.hot-labs.org",
                    "https://hot-labs.org/wallet",
                    "https://t.me/hot_wallet/app",
                    "https://play.google.com",
                    "https://apps.apple.com",
                    "hotwallet://"
                ]
            }
        }
    ]
};
