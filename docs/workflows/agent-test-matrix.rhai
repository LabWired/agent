// LabWired agent — multi-lane test matrix (harness, install, skills, LLM optional)

let meta = #{
    name: "agent-test-matrix",
    description: "Run full LabWired agent test matrix: unit, skills, install smoke, optional DeepInfra LLM",
    when_to_use: "After install/portable changes or before release",
    phases: [
        #{ title: "Unit", detail: "harness, prefix, public-install, skills" },
        #{ title: "Install", detail: "portable temp prefix smoke" },
        #{ title: "LLM", detail: "DeepInfra Kimi if key present" },
        #{ title: "Report", detail: "summarize pass/fail" },
    ],
};

let lane_schema = #{
    "type": "object",
    "required": ["lane", "pass", "evidence"],
    "properties": #{
        "lane": #{ "type": "string" },
        "pass": #{ "type": "boolean" },
        "evidence": #{ "type": "string" },
    },
};

let report_schema = #{
    "type": "object",
    "required": ["summary", "all_pass", "lanes"],
    "properties": #{
        "summary": #{ "type": "string" },
        "all_pass": #{ "type": "boolean" },
        "lanes": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let root = if args == () { () } else { args.root };
if root == () {
    root = "/Users/andrii/Projects/labwired-agent";
}

log("agent-test-matrix root=" + root);

phase("Unit");

let u1 = "";
u1 += "You are a test runner for LabWired agent at " + root + ".\n";
u1 += "Run ONLY: bash " + root + "/tests/harness.sh\n";
u1 += "Use run_terminal_command. Capture exit code and last 30 lines as evidence.\n";
u1 += "Set pass=true only if exit code 0. lane=harness.\n";

let u2 = "";
u2 += "Run ONLY: bash " + root + "/tests/skills-inventory.sh && bash " + root + "/tests/public-install.sh && bash " + root + "/tests/prefix-unit.sh\n";
u2 += "Working directory " + root + ". pass=true only if all exit 0. lane=unit-pack. Quote command output in evidence.\n";

let unit_jobs = [
    #{ prompt: u1, label: "lane-harness", capability_mode: "all", output_schema: lane_schema, cwd: root },
    #{ prompt: u2, label: "lane-unit-pack", capability_mode: "all", output_schema: lane_schema, cwd: root },
];
let unit_results = parallel(unit_jobs);

phase("Install");

let i1 = "";
i1 += "Run install smoke for LabWired agent.\n";
i1 += "Command: bash " + root + "/tests/install-smoke.sh\n";
i1 += "This installs to a temp LABWIRED_HOME and runs smoke. May take a few minutes (sim download).\n";
i1 += "pass=true only exit 0. lane=install-smoke. Evidence must include smoke PASS or failure snippet.\n";

let inst = agent(i1, #{
    label: "lane-install-smoke",
    capability_mode: "all",
    output_schema: lane_schema,
    cwd: root,
});

phase("LLM");

let l1 = "";
l1 += "Run optional DeepInfra LLM lane for LabWired agent.\n";
l1 += "Command: bash " + root + "/tests/llm-deepinfra.sh\n";
l1 += "If DEEPINFRA_API_KEY is missing, the script skips with exit 0 — treat skip as pass=true with evidence 'skipped no key'.\n";
l1 += "If key present, require ok llm-deepinfra PASS. Model default moonshotai/Kimi-K2.5.\n";
l1 += "lane=llm-deepinfra. Do not print API keys.\n";

let llm = agent(l1, #{
    label: "lane-llm",
    capability_mode: "all",
    output_schema: lane_schema,
    cwd: root,
});

phase("Report");

let lanes = [];
let all_pass = true;

for r in unit_results {
    if r != () && r.success && r.output != () {
        lanes.push(r.output.lane + ":" + r.output.pass.to_string());
        if r.output.pass != true { all_pass = false; }
    } else {
        lanes.push("unit:false");
        all_pass = false;
    }
}
if inst != () && inst.success && inst.output != () {
    lanes.push(inst.output.lane + ":" + inst.output.pass.to_string());
    if inst.output.pass != true { all_pass = false; }
} else {
    lanes.push("install-smoke:false");
    all_pass = false;
}
if llm != () && llm.success && llm.output != () {
    lanes.push(llm.output.lane + ":" + llm.output.pass.to_string());
    if llm.output.pass != true { all_pass = false; }
} else {
    lanes.push("llm:false");
    all_pass = false;
}

let rep_prompt = "";
rep_prompt += "Write a short markdown test report for LabWired agent.\n";
rep_prompt += "Root: " + root + "\n";
rep_prompt += "Lanes (name:pass): " + json_encode(lanes) + "\n";
rep_prompt += "all_pass computed: " + all_pass.to_string() + "\n";
rep_prompt += "Write file: " + root + "/docs/superpowers/specs/2026-07-29-test-matrix-report.md\n";
rep_prompt += "Include: what ran, what needs DEEPINFRA_API_KEY, next CI steps.\n";
rep_prompt += "Return summary, all_pass, lanes.\n";

let rep = agent(rep_prompt, #{
    label: "report",
    capability_mode: "read-write",
    output_schema: report_schema,
    cwd: root,
});

if rep != () && rep.success && rep.output != () {
    complete(rep.output);
}
complete(#{
    summary: "test matrix finished",
    all_pass: all_pass,
    lanes: lanes,
});
