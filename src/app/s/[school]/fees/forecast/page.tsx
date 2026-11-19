import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays, History, Wallet } from "lucide-react";
import { ForecastChart } from "@/components/forecast/forecast-chart";
import { Figures } from "@/components/overview/figures";
import { ScopePicker } from "@/components/overview/scope-picker";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { narrowToCampus } from "@/server/fees/access";
import { getCollectionForecast } from "@/server/forecasting/forecast";
import { percent } from "@/lib/dashboard";
import { formatCalendarDate } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { chooseTerm } from "@/web/terms";

export const metadata: Metadata = { title: "Fees · Forecast" };

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GH", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
const span = (from: string, to: string) =>
  from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;

/**
 * The collection forecast (R5-2, FCT-01): what the school can expect to collect by week to the end of the term, from
 * its own past terms, labelled as a forecast with its range and how last term's forecast turned out.
 */
export default async function ForecastPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string; campus?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "forecasting.view")) notFound();
  const slug = ctx.tenant.slug;
  const money = moneyFormatter(ctx.tenant.currencyCode);
  const { terms, term } = await chooseTerm(ctx, search.term);
  const campuses = (await listCampuses(db(), ctx)).filter((c) => c.status === "active");
  const scoped = narrowToCampus(ctx, campuses.length > 1 ? search.campus : null);
  const campus = scoped === ctx ? null : (campuses.find((c) => c.id === search.campus) ?? null);
  const result = term ? await getCollectionForecast(db(), scoped, term.id) : null;

  const picker =
    (terms.length > 1 && term) || campuses.length > 1 ? (
      <ScopePicker
        terms={terms}
        termId={term?.id ?? null}
        campuses={campuses}
        campusId={campus?.id ?? null}
      />
    ) : null;
  const where = campus ? `${campus.name} campus` : "the school";

  if (!result)
    return (
      <Section title="Collection forecast">
        <EmptyState
          icon={<CalendarDays />}
          title="No terms yet"
          description="Set up the academic year and its terms in Settings, Calendar; the forecast counts from them."
        />
      </Section>
    );
  const { forecast, backtest } = result;

  return (
    <div className="space-y-12">
      {picker && <div className="flex justify-end">{picker}</div>}
      <Section
        title="Collection forecast"
        description={`${result.term.label}, ${where}: ${formatCalendarDate(result.term.startsOn)} to ${formatCalendarDate(result.term.endsOn)}. A forecast from the school's own past terms, not a promise.`}
      >
        {forecast.status === "not_billed" && (
          <EmptyState
            icon={<Wallet />}
            title="No fees billed for this term yet"
            description="The forecast starts once the term is billed: it is a share of what the term billed."
          />
        )}
        {forecast.status === "no_history" && (
          <EmptyState
            icon={<History />}
            title="Not enough history to forecast yet"
            description="A forecast needs at least one complete past term with fees billed in EduBridge. Until then, the Payments report shows what has come in."
          />
        )}
        {forecast.status === "ended" && (
          <Figures
            items={[
              { label: "Billed for the term", value: money(forecast.billedPesewas) },
              {
                label: "Collected in the term",
                value: money(forecast.collectedPesewas),
                note: `${percent(forecast.collectedPesewas, forecast.billedPesewas) ?? 0}% of billed. The term has ended, so there is nothing to forecast.`,
                href: `${schoolPath(slug, "fees/payments")}?from=${result.term.startsOn}&to=${result.term.endsOn}`,
              },
            ]}
          />
        )}
        {forecast.status === "forecast" && (
          <div className="space-y-8">
            <Figures
              items={[
                {
                  label: "Billed for the term",
                  value: money(forecast.billedPesewas),
                  note: "Charges less discounts",
                },
                {
                  label: "Collected so far",
                  value: money(forecast.collectedPesewas),
                  note: `${percent(forecast.collectedPesewas, forecast.billedPesewas) ?? 0}% of billed, to ${formatCalendarDate(result.asOf)}`,
                  href: `${schoolPath(slug, "fees/payments")}?from=${result.term.startsOn}&to=${result.asOf}`,
                },
                {
                  label: "Forecast by the end of term",
                  value: money(forecast.endOfTerm.likelyPesewas),
                  note: `Likely; between ${money(forecast.endOfTerm.lowPesewas)} and ${money(forecast.endOfTerm.highPesewas)}`,
                },
                {
                  label: "Forecast collection rate",
                  value: `${percent(forecast.endOfTerm.likelyPesewas, forecast.billedPesewas) ?? 0}%`,
                  note: "Of the term's billed fees, likely",
                },
              ]}
            />
            <ForecastChart
              currency={ctx.tenant.currencyCode}
              caption={`Collected and forecast each week, ${result.term.label}`}
              weeks={forecast.weeks.map((w) => ({
                from: w.from,
                label: span(w.from, w.to),
                actualPesewas: w.actualPesewas,
                likelyPesewas: w.expected?.likelyPesewas ?? null,
                lowPesewas: w.expected?.lowPesewas ?? null,
                highPesewas: w.expected?.highPesewas ?? null,
              }))}
            />
            <p className="max-w-3xl text-sm text-ink-2">
              Based on{" "}
              {forecast.basedOn.length === 1 ? "one past term" : `${forecast.basedOn.length} past terms`} (
              {forecast.basedOn.map((t) => t.label).join("; ")}): for each, the share of its billed fees it
              went on to collect from this day of term. Likely is the middle of those terms, the range the
              lowest and highest. It is for the {campus ? "campus" : "school"} as a whole, never for a family.
            </p>
          </div>
        )}
      </Section>

      {forecast.status === "forecast" && (
        <Section
          title="Week by week"
          description="Expected amounts are forecasts. Plan instalments are what active payment plans have scheduled; they are shown beside the forecast, not added to it."
        >
          <TableFrame>
            <Table>
              <caption className="sr-only">Collected and forecast each week</caption>
              <THead>
                <tr>
                  <TH>Week</TH>
                  <TH className="text-right">Collected</TH>
                  <TH className="text-right">Forecast, likely</TH>
                  <TH className="hidden text-right sm:table-cell">Forecast range</TH>
                  <TH className="hidden text-right md:table-cell">Plan instalments due</TH>
                </tr>
              </THead>
              <TBody>
                {forecast.weeks.map((w) => (
                  <TR key={w.from}>
                    <TD className="font-medium text-ink">{span(w.from, w.to)}</TD>
                    <TD className="text-right tabular-nums">
                      {w.actualPesewas === null ? "—" : money(w.actualPesewas)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {w.expected ? money(w.expected.likelyPesewas) : "—"}
                    </TD>
                    <TD className="hidden text-right text-ink-2 tabular-nums sm:table-cell">
                      {w.expected
                        ? `${money(w.expected.lowPesewas)} – ${money(w.expected.highPesewas)}`
                        : "—"}
                    </TD>
                    <TD className="hidden text-right text-ink-2 tabular-nums md:table-cell">
                      {w.instalmentsPesewas ? money(w.instalmentsPesewas) : "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        </Section>
      )}

      {forecast.status === "forecast" && (
        <Section
          title="How last term's forecast turned out"
          description="The same method, applied to the last complete term at the same day of term, against what it collected."
        >
          {backtest ? (
            <Figures
              items={[
                {
                  label: `Forecast for ${backtest.label}`,
                  value: money(backtest.forecastPesewas),
                  note: `Made at day ${backtest.day} of that term`,
                },
                { label: "What it collected", value: money(backtest.collectedPesewas) },
                {
                  label: "Difference",
                  value:
                    backtest.errorPercent === null
                      ? "—"
                      : backtest.errorPercent === 0
                        ? "On target"
                        : `${Math.abs(backtest.errorPercent)}% ${backtest.errorPercent > 0 ? "over" : "under"}`,
                  note: "Forecast against what was collected",
                },
              ]}
            />
          ) : (
            <p className="text-base text-ink-2">
              Not yet: checking last term needs a complete term before it, so there was something to forecast
              from.
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
