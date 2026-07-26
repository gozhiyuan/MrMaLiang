# Bounded AutoResearch optimization pilot

This is a configuration-only pilot blueprint. It pins a repository revision,
limits mutation to `train.py`, and treats the evaluator, data preparation, and
program contract as protected. Run it only after issuing an unattended lease
and configuring the Modal adapter; this example never embeds credentials.
