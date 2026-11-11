// O pouco do next/server que as rotas portadas do CX Hub usam, para rodarem no Worker com a assinatura do Next:
// NextRequest (a requisição com nextUrl), NextResponse.json e after(). O roteador (api/roteador.ts) entrega a cada
// rota a requisição com o nextUrl e, quando ela responde, segura no ctx.waitUntil do Worker as tarefas que o after()
// deixou rodando. Nos testes, o alias "next/server" aponta para este arquivo.

/** A requisição que as rotas recebem: a da web, com a URL já lida em `nextUrl` (como no Next). */
export class NextRequest extends Request {
  readonly nextUrl: URL;

  constructor(entrada: RequestInfo | URL, init?: RequestInit) {
    super(entrada, init);
    this.nextUrl = new URL(this.url);
  }
}

/** No Next, NextResponse<T> carrega o tipo do corpo; aqui é a Response da web, e o parâmetro só documenta. */
export type NextResponse<Corpo = unknown> = Response;

export const NextResponse = {
  /** Corpo em JSON, como o NextResponse.json: status e headers do init, content-type JSON se ninguém deu outro. */
  json<Corpo>(corpo: Corpo, init?: ResponseInit): NextResponse<Corpo> {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(corpo), { ...init, headers });
  },
};

// Tarefas que o after() começou e que ainda não terminaram, de qualquer requisição deste isolate.
const pendentes = new Set<Promise<void>>();

/**
 * Roda a tarefa depois do trabalho da rota, sem atrasar a resposta (no Next, roda depois de a resposta sair). Sem
 * AsyncLocalStorage não há como saber de qual requisição ela é; não precisa: ela começa já e fica em `pendentes`, e o
 * roteador, quando qualquer rota responde, entrega todas as pendentes ao ctx.waitUntil daquela requisição. A da própria
 * requisição está entre elas, porque a rota a agendou antes de responder. Erro da tarefa vai ao log; nunca sobe.
 */
export function after(tarefa: () => unknown): void {
  const p: Promise<void> = Promise.resolve()
    .then(tarefa)
    .then(
      () => undefined,
      (erro: unknown) => console.error("[after] a tarefa falhou:", erro instanceof Error ? erro.stack || erro.message : erro),
    )
    .finally(() => pendentes.delete(p));
  pendentes.add(p);
}

/** O que o roteador passa ao ctx.waitUntil quando uma rota responde: as tarefas ainda em andamento, ou null. */
export function tarefasPendentes(): Promise<unknown> | null {
  return pendentes.size ? Promise.allSettled([...pendentes]) : null;
}
