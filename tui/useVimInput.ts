import { useInput, type Key } from 'ink';

type InputOptions = {
  isActive?: boolean;
  isTyping?: boolean;
};

/** Adds Vim directions while preserving the original input for text fields. */
export function useVimInput(
  handler: (input: string, key: Key) => void,
  options?: InputOptions,
): void {
  const { isTyping = false, ...inputOptions } = options ?? {};
  useInput((input, key) => {
    const vim = !isTyping && !key.ctrl && !key.meta && input.length === 1;
    handler(input, {
      ...key,
      leftArrow: key.leftArrow || (vim && input === 'h'),
      downArrow: key.downArrow || (vim && input === 'j'),
      upArrow: key.upArrow || (vim && input === 'k'),
      rightArrow: key.rightArrow || (vim && input === 'l'),
    });
  }, inputOptions);
}
