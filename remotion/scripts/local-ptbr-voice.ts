export type MacOsSayVoice = {
  name: string;
  locale: string;
};

export const parseMacOsSayVoices = (output: string): MacOsSayVoice[] => output
  .split(/\r?\n/u)
  .map((line) => line.match(/^(.+?)\s+([a-z]{2,3}(?:_[A-Z0-9]{2,3})+)\s+#/u))
  .filter((match): match is RegExpMatchArray => match !== null)
  .map((match) => ({
    name: match[1].trim(),
    locale: match[2],
  }));

export const assertLocalPtBrVoice = ({
  voiceName,
  voicesOutput,
}: {
  voiceName: string;
  voicesOutput: string;
}): MacOsSayVoice => {
  const voice = parseMacOsSayVoices(voicesOutput).find((candidate) => candidate.name === voiceName);

  if (!voice) {
    throw new Error(`A voz local "${voiceName}" não está instalada. Escolha uma entrada exata exibida por say -v '?'.`);
  }
  if (voice.locale !== 'pt_BR') {
    throw new Error(
      `A voz local "${voiceName}" usa ${voice.locale}, não pt_BR. A prévia aceita somente uma voz brasileira instalada.`,
    );
  }

  return voice;
};
