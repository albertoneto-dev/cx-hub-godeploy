// Só para o tsc do Worker: código de navegador que os barrels do CX Hub trazem para o fecho das rotas
// (cxhub/shared/lib/auth/auth-utils.ts e cxhub/shared/lib/registro/enviadas.ts). Ele só toca nestes nomes depois de
// conferir `typeof window` ou `typeof localStorage`, que no Worker dá "undefined"; no Worker eles não existem.
interface Storage {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}
declare var localStorage: Storage;
declare var window: { location: { href: string } };
