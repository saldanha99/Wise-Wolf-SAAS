export const assertElevenLabsCollectionCapacity = ({
  characterCount,
  characterLimit,
  requiredCharacters,
}: {
  characterCount: number | undefined;
  characterLimit: number | undefined;
  requiredCharacters: number;
}): void => {
  if (!Number.isFinite(requiredCharacters) || requiredCharacters < 0) {
    throw new Error('Quantidade de caracteres da coleção inválida.');
  }
  if (requiredCharacters === 0) return;

  const used = Number(characterCount);
  const limit = Number(characterLimit);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return;

  const available = Math.max(0, limit - used);
  if (available >= requiredCharacters) return;

  throw new Error(
    `Saldo ElevenLabs insuficiente para gerar a coleção em um lote seguro. `
    + `Faltam pelo menos ${requiredCharacters - available} caracteres; nenhum áudio foi alterado.`,
  );
};
