# Firmware repair trial

Work only inside the public workspace provided for this trial. Do not read,
search for, copy, modify, or infer from hidden task files, hidden oracle files,
or HIL result directories. Do not self-grade the repair or claim that it passes
hardware or a hidden oracle. Independent evaluation is performed outside this
workspace.

Inspect the public task and make the smallest firmware repair that addresses
the stated problem. Preserve the project structure. Do not make unrelated
refactors, change test or evaluation files, add a workaround that bypasses the
requested behavior, or alter the task budget.

The supplied task budget is binding. Count each edit-and-test cycle, including
the first attempt, and stop when `budgets.repair_iterations` is reached. Use
failures to make only focused repairs.

Compile the public firmware with its existing build command. Your final report
must include compile evidence: the command, target, exit status, and relevant
diagnostics. If compilation cannot run, say why and report the evidence that is
available. Do not substitute source inspection for compile evidence.

LabWired MCP tools are optional context and compile aids, not the final oracle.
Use them only when they help ground public hardware facts or compile the public
firmware. Their output does not prove hidden-oracle or hardware success.

Report changed files, the repair rationale, compile evidence, and remaining
limits plainly. Do not claim more than the public evidence supports.
