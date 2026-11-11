// As marcas do CX Hub e a sigla de cada uma na gold.fct_reenvio_reembolso_gobeaute. O filtro é pela sigla: a coluna
// `marca` tem acento e apóstrofo ("Barbour's", "Auá"). As siglas são as do SIGLA_DA_MARCA do CX Hub
// (shared/lib/airflow/gold.ts): Denavita é DV (a sigla da base consolidada, embora o pedido seja ...DN) e Gobeaute, GB.

export const MARCAS = [
  { sigla: "LE", nome: "Lescent" },
  { sigla: "KO", nome: "Kokeshi" },
  { sigla: "BS", nome: "By Samia" },
  { sigla: "AU", nome: "Auá" },
  { sigla: "BB", nome: "Barbour's" },
  { sigla: "RT", nome: "Rituária" },
  { sigla: "AP", nome: "Ápice" },
  { sigla: "YE", nome: "Yenzah" },
  { sigla: "DV", nome: "Denavita" },
  { sigla: "GB", nome: "Gobeaute" },
] as const;

export type Sigla = (typeof MARCAS)[number]["sigla"];

export const SIGLAS: ReadonlySet<string> = new Set(MARCAS.map(m => m.sigla));
