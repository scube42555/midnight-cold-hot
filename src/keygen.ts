// Prints a new 24-word recovery phrase. Use it for throwaway test wallets only.
// A phrase that has been shown on an online machine must not hold real funds.
import { generateMnemonicWords } from '@midnightntwrk/wallet-sdk';

console.log(generateMnemonicWords().join(' '));
