//! `beebranch-bench` command line.
//!
//! Generates or reuses a deterministic corpus, measures one scenario (or the
//! reduced CI set), writes a versioned JSON report and optionally enforces a
//! baseline. Exit codes: 0 success, 1 regression, 2 harness/usage error.

use std::path::PathBuf;
use std::process::ExitCode;

use beebranch_bench::corpus::{Corpus, CorpusName, CorpusScale, CorpusSpec};
use beebranch_bench::error::{BenchError, Result};
use beebranch_bench::metrics::Environment;
use beebranch_bench::report::{write_json, BatchReport, BenchmarkReport};
use beebranch_bench::scenario::ScenarioId;
use beebranch_bench::threshold::{check_all, check_baseline, load_baseline, Baseline};
use beebranch_bench::{run_scenario, BenchConfig};
use beebranch_git::GitRunner;

const USAGE: &str = "\
beebranch-bench — harnais de performance BeeBranch

USAGE :
  beebranch-bench --root <dir> --corpus <nom> --scenario <PERF-xx> [options]
  beebranch-bench --root <dir> --all-reduced [options]

OPTIONS :
  --root <dir>        Racine des corpus (défaut : target/bench-corpus)
  --corpus <nom>      Corpus explicite (linear-10k, branches-5k, diff-50k, ...)
  --scenario <id>     Scénario PERF-01..PERF-12 (sous-ensemble implémenté)
  --runs <n>          Mesures après chauffe (défaut : 5)
  --warmup <n>        Exécutions de chauffe non mesurées (défaut : 2)
  --seed <n>          Graine du corpus (défaut : 42)
  --out <fichier>     Rapport JSON (défaut : stdout ; '-' pour stdout)
  --baseline <fichier> Baseline JSON à respecter
  --assert            Échoue si un seuil de baseline est dépassé
  --all-reduced       Exécute les scénarios CI sur leurs corpus réduits
  -h, --help          Affiche cette aide

SCÉNARIOS : PERF-01..PERF-12 (tous mesurables)

Avec --assert, un corpus unique absent est refusé (générez-le d'abord sans
--assert). --all-reduced génère ses corpus réduits pour rester utilisable en CI.
";

const DEFAULT_ROOT: &str = "target/bench-corpus";
const DEFAULT_SEED: u64 = 42;

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("beebranch-bench : {error}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<u8> {
    let Some(cli) = Cli::parse()? else {
        print!("{USAGE}");
        return Ok(0);
    };

    let runner = GitRunner::detect()?;
    let environment = Environment::detect(&runner)?;
    let baseline: Option<Baseline> = match &cli.baseline {
        Some(path) => Some(load_baseline(path)?),
        None => None,
    };

    if cli.all_reduced {
        return run_all_reduced(&cli, &runner, &environment, baseline.as_ref());
    }
    run_single(&cli, &runner, &environment, baseline.as_ref())
}

fn run_single(
    cli: &Cli,
    runner: &GitRunner,
    environment: &Environment,
    baseline: Option<&Baseline>,
) -> Result<u8> {
    let scenario = cli
        .scenario
        .ok_or_else(|| BenchError::Usage("--scenario est requis sans --all-reduced".to_owned()))?;
    let name = cli.corpus.unwrap_or_else(|| scenario.corpus());
    let spec = CorpusSpec {
        name,
        seed: cli.seed,
        scale: CorpusScale::Full,
    };

    if cli.assert && !Corpus::is_ready(&cli.root, &spec) {
        return Err(BenchError::Corpus(format!(
            "corpus absent : {} (graine {}). Générez-le sans --assert, ou utilisez --all-reduced.",
            Corpus::path(&cli.root, &spec).display(),
            cli.seed
        )));
    }

    let corpus = Corpus::ensure(&cli.root, &spec)?;
    report_corpus(&corpus);
    let report = run_scenario(
        runner,
        scenario,
        &corpus,
        environment,
        BenchConfig {
            warmup: cli.warmup,
            runs: cli.runs,
        },
    )?;
    write_json(cli.out.as_deref(), &report)?;

    if let Some(baseline) = baseline {
        if cli.assert {
            if let Err(violations) = check_baseline(&report, baseline) {
                for violation in &violations {
                    eprintln!("régression : {violation}");
                }
                return Ok(1);
            }
        }
    }
    Ok(0)
}

fn run_all_reduced(
    cli: &Cli,
    runner: &GitRunner,
    environment: &Environment,
    baseline: Option<&Baseline>,
) -> Result<u8> {
    let mut reports: Vec<BenchmarkReport> = Vec::with_capacity(ScenarioId::ALL.len());
    for scenario in ScenarioId::ALL_REDUCED {
        let spec = CorpusSpec {
            name: scenario.corpus(),
            seed: cli.seed,
            scale: CorpusScale::Reduced,
        };
        let corpus = Corpus::ensure(&cli.root, &spec)?;
        report_corpus(&corpus);
        reports.push(run_scenario(
            runner,
            scenario,
            &corpus,
            environment,
            BenchConfig {
                warmup: cli.warmup,
                runs: cli.runs,
            },
        )?);
    }

    let batch = BatchReport::new(environment, reports);
    write_json(cli.out.as_deref(), &batch)?;

    if cli.assert {
        if let Some(baseline) = baseline {
            let violations = check_all(&batch.reports, baseline);
            if !violations.is_empty() {
                for violation in &violations {
                    eprintln!("régression : {violation}");
                }
                return Ok(1);
            }
        }
    }
    Ok(0)
}

fn report_corpus(corpus: &beebranch_bench::corpus::CorpusInfo) {
    eprintln!(
        "corpus {} ({}) : {} commits, {} fichiers, {} — {}",
        corpus.name.as_str(),
        corpus.scale.as_str(),
        corpus.commits,
        corpus.files,
        corpus.path.display(),
        if corpus.reused {
            "réutilisé"
        } else {
            "généré"
        }
    );
}

#[derive(Debug)]
struct Cli {
    root: PathBuf,
    corpus: Option<CorpusName>,
    scenario: Option<ScenarioId>,
    runs: u32,
    warmup: u32,
    out: Option<PathBuf>,
    baseline: Option<PathBuf>,
    assert: bool,
    all_reduced: bool,
    seed: u64,
}

impl Cli {
    /// Parse arguments. `Ok(None)` means help was requested.
    fn parse() -> Result<Option<Self>> {
        let mut cli = Self {
            root: PathBuf::from(DEFAULT_ROOT),
            corpus: None,
            scenario: None,
            runs: 5,
            warmup: 2,
            out: None,
            baseline: None,
            assert: false,
            all_reduced: false,
            seed: DEFAULT_SEED,
        };
        let mut arguments = std::env::args().skip(1).peekable();

        while let Some(raw) = arguments.next() {
            let (flag, inline) = match raw.split_once('=') {
                Some((flag, value)) => (flag.to_owned(), Some(value.to_owned())),
                None => (raw, None),
            };
            match flag.as_str() {
                "-h" | "--help" => return Ok(None),
                "--assert" => cli.assert = true,
                "--all-reduced" => cli.all_reduced = true,
                "--root" => cli.root = PathBuf::from(value(&mut arguments, inline, &flag)?),
                "--corpus" => {
                    let text = value(&mut arguments, inline, &flag)?;
                    cli.corpus = Some(CorpusName::parse(&text).ok_or_else(|| {
                        BenchError::Usage(format!(
                            "corpus inconnu : {text} ; disponibles : {}",
                            CorpusName::ALL.map(CorpusName::as_str).join(", ")
                        ))
                    })?);
                }
                "--scenario" => {
                    let text = value(&mut arguments, inline, &flag)?;
                    cli.scenario = Some(ScenarioId::parse(&text).map_err(BenchError::Usage)?);
                }
                "--runs" => cli.runs = parse_u32(&value(&mut arguments, inline, &flag)?, &flag)?,
                "--warmup" => {
                    cli.warmup = parse_u32(&value(&mut arguments, inline, &flag)?, &flag)?
                }
                "--seed" => {
                    cli.seed = value(&mut arguments, inline, &flag)?
                        .parse()
                        .map_err(|_| BenchError::Usage("--seed doit être un entier".to_owned()))?;
                }
                "--out" => cli.out = Some(PathBuf::from(value(&mut arguments, inline, &flag)?)),
                "--baseline" => {
                    cli.baseline = Some(PathBuf::from(value(&mut arguments, inline, &flag)?))
                }
                other => {
                    return Err(BenchError::Usage(format!(
                        "option inconnue : {other} (voir --help)"
                    )))
                }
            }
        }

        if cli.runs == 0 {
            return Err(BenchError::Usage("--runs doit être ≥ 1".to_owned()));
        }
        if cli.all_reduced && (cli.scenario.is_some() || cli.corpus.is_some()) {
            return Err(BenchError::Usage(
                "--all-reduced est exclusif avec --scenario et --corpus".to_owned(),
            ));
        }
        if !cli.all_reduced && cli.corpus.is_some() && cli.scenario.is_none() {
            return Err(BenchError::Usage(
                "--corpus nécessite --scenario".to_owned(),
            ));
        }
        if cli.assert && cli.baseline.is_none() {
            return Err(BenchError::Usage(
                "--assert nécessite --baseline".to_owned(),
            ));
        }
        Ok(Some(cli))
    }
}

fn value(
    arguments: &mut std::iter::Peekable<impl Iterator<Item = String>>,
    inline: Option<String>,
    flag: &str,
) -> Result<String> {
    match inline {
        Some(value) => Ok(value),
        None => arguments
            .next()
            .ok_or_else(|| BenchError::Usage(format!("valeur manquante pour {flag}"))),
    }
}

fn parse_u32(text: &str, flag: &str) -> Result<u32> {
    text.parse()
        .map_err(|_| BenchError::Usage(format!("{flag} doit être un entier positif")))
}
