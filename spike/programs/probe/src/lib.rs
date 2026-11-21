//! Spike probe: answers four devnet TEE questions before the real program is designed.
//! 1. private ephemeral permission read gating, 2. VRF from inside the TEE ER,
//! 3. native crank firing, 4. zero-lamport signers on the TEE ER.
#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi},
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED,
        },
    },
    anchor::{delegate, ephemeral, vrf, vrf_callback},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    crank::{ScheduleCrankCpi, ScheduleTaskArgs},
    vrf::{
        self,
        consts::program_identity_pubkey,
        instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

declare_id!("91TR6rWBaaXHMmm8dRfyD2B6C61J3XgnvTRW1rtXfCM8");

pub const PROBE_SEED: &[u8] = b"probe";
const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
const MAX_MEMBERS: usize = 2;

#[ephemeral]
#[program]
pub mod probe {
    use super::*;

    /// Base: create and pre-fund the probe PDA (permission rent travels with it).
    pub fn init(ctx: Context<Init>, id: u64) -> Result<()> {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.probe.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(
                EphemeralPermission::size_of(MAX_MEMBERS) as u32,
            ),
        )?;
        let p = &mut ctx.accounts.probe;
        p.authority = ctx.accounts.authority.key();
        p.id = id;
        Ok(())
    }

    /// Base: delegate the probe PDA to the given validator.
    pub fn delegate_probe(ctx: Context<DelegateProbe>, id: u64) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let id_bytes = id.to_le_bytes();
        ctx.accounts.delegate_probe(
            &ctx.accounts.authority,
            &[PROBE_SEED, authority.as_ref(), &id_bytes],
            DelegateConfig {
                validator: ctx.accounts.validator.as_ref().map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// ER: create the ephemeral permission (private, single member).
    pub fn create_permission(ctx: Context<PermissionCtx>, member: Pubkey, flags: u8) -> Result<()> {
        let id_bytes = ctx.accounts.probe.id.to_le_bytes();
        let bump = [ctx.bumps.probe];
        let seeds: &[&[u8]] = &[
            PROBE_SEED,
            ctx.accounts.probe.authority.as_ref(),
            &id_bytes,
            &bump,
        ];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.probe.to_account_info(),
            permissioned_account: ctx.accounts.probe.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags,
                    pubkey: member,
                }],
            },
        }
        .invoke_signed(&[seeds])?;
        Ok(())
    }

    /// ER: one transaction writing two private probes (visibility of multi-account txs).
    pub fn poke_pair(ctx: Context<PokePair>) -> Result<()> {
        ctx.accounts.probe_a.pokes = ctx.accounts.probe_a.pokes.saturating_add(1);
        ctx.accounts.probe_b.pokes = ctx.accounts.probe_b.pokes.saturating_add(1);
        Ok(())
    }

    /// ER: make the permission public (reveal).
    pub fn set_public(ctx: Context<PermissionCtx>) -> Result<()> {
        let id_bytes = ctx.accounts.probe.id.to_le_bytes();
        let bump = [ctx.bumps.probe];
        let seeds: &[&[u8]] = &[
            PROBE_SEED,
            ctx.accounts.probe.authority.as_ref(),
            &id_bytes,
            &bump,
        ];
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.probe.to_account_info(),
            permissioned_account: ctx.accounts.probe.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.probe.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private: false,
                members: vec![],
            },
        }
        .invoke_signed(&[seeds])?;
        Ok(())
    }

    /// ER: any signer bumps the counter (tests zero-lamport and non-member signers).
    pub fn poke(ctx: Context<Poke>) -> Result<()> {
        let p = &mut ctx.accounts.probe;
        p.pokes = p.pokes.saturating_add(1);
        p.last_poker = ctx.accounts.signer.key();
        Ok(())
    }

    /// ER: crank target. Permissionless on purpose for the spike.
    pub fn tick(ctx: Context<Tick>) -> Result<()> {
        let p = &mut ctx.accounts.probe;
        p.ticks = p.ticks.saturating_add(1);
        p.last_tick_slot = Clock::get()?.slot;
        Ok(())
    }

    /// ER: crank target with no signer that flips the permission public after 3 ticks.
    pub fn tick_reveal(ctx: Context<TickReveal>) -> Result<()> {
        let ticks = ctx.accounts.probe.ticks.saturating_add(1);
        ctx.accounts.probe.ticks = ticks;
        ctx.accounts.probe.last_tick_slot = Clock::get()?.slot;
        if ticks == 3 {
            let id_bytes = ctx.accounts.probe.id.to_le_bytes();
            let bump = [ctx.bumps.probe];
            let seeds: &[&[u8]] = &[
                PROBE_SEED,
                ctx.accounts.probe.authority.as_ref(),
                &id_bytes,
                &bump,
            ];
            UpdateEphemeralPermissionCpi {
                payer: ctx.accounts.probe.to_account_info(),
                permissioned_account: ctx.accounts.probe.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: ctx.accounts.probe.to_account_info(),
                authority_is_signer: false,
                args: EphemeralMembersArgs {
                    is_private: false,
                    members: vec![],
                },
            }
            .invoke_signed(&[seeds])?;
        }
        Ok(())
    }

    /// ER: schedule `tick_reveal` as a native crank.
    pub fn schedule_reveal<'info>(
        ctx: Context<'info, ScheduleReveal<'info>>,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        let a: &'info ScheduleReveal<'info> = ctx.accounts;
        let ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(a.probe.key(), false),
                AccountMeta::new(a.permission.key(), false),
                AccountMeta::new_readonly(PERMISSION_PROGRAM_ID, false),
                AccountMeta::new(EPHEMERAL_VAULT_ID, false),
                AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::TickReveal {}),
        };
        ScheduleCrankCpi {
            payer: &a.payer,
            magic_program: &a.magic_program,
            instruction_accounts: &[
                a.probe.to_account_info(),
                a.permission.to_account_info(),
                a.permission_program.to_account_info(),
                a.ephemeral_vault.to_account_info(),
            ],
            args: ScheduleTaskArgs {
                task_id,
                execution_interval_millis: interval_ms,
                iterations,
                instructions: vec![ix],
            },
        }
        .invoke()?;
        Ok(())
    }

    /// ER: schedule `tick` as a native crank.
    pub fn schedule_ticks<'info>(
        ctx: Context<'info, ScheduleTicks<'info>>,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        let a: &'info ScheduleTicks<'info> = ctx.accounts;
        let tick_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(a.probe.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Tick {}),
        };
        ScheduleCrankCpi {
            payer: &a.payer,
            magic_program: &a.magic_program,
            instruction_accounts: &[a.probe.to_account_info()],
            args: ScheduleTaskArgs {
                task_id,
                execution_interval_millis: interval_ms,
                iterations,
                instructions: vec![tick_ix],
            },
        }
        .invoke()?;
        Ok(())
    }

    /// ER: request randomness from the delegated (ephemeral) queue.
    pub fn request_vrf(ctx: Context<RequestVrf>, seed: u8) -> Result<()> {
        let ix = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: ctx.accounts.payer.key(),
                oracle_queue: ctx.accounts.oracle_queue.key(),
                callback_program_id: crate::ID,
                callback_discriminator: crate::instruction::CallbackVrf::DISCRIMINATOR.to_vec(),
                caller_seed: [seed; 32],
                accounts_metas: Some(vec![SerializableAccountMeta {
                    pubkey: ctx.accounts.probe.key(),
                    is_signer: false,
                    is_writable: true,
                }]),
                ..Default::default()
            },
            PROGRAM_IDENTITY,
        );
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        ctx.accounts.probe.vrf_requests = ctx.accounts.probe.vrf_requests.saturating_add(1);
        Ok(())
    }

    pub fn callback_vrf(ctx: Context<CallbackVrf>, randomness: [u8; 32]) -> Result<()> {
        let p = &mut ctx.accounts.probe;
        p.randomness = randomness;
        p.vrf_fulfilled = p.vrf_fulfilled.saturating_add(1);
        Ok(())
    }
}

#[account]
pub struct Probe {
    pub authority: Pubkey,
    pub id: u64,
    pub pokes: u64,
    pub last_poker: Pubkey,
    pub ticks: u64,
    pub last_tick_slot: u64,
    pub vrf_requests: u64,
    pub vrf_fulfilled: u64,
    pub randomness: [u8; 32],
}

impl Probe {
    pub const LEN: usize = 32 + 8 + 8 + 32 + 8 + 8 + 8 + 8 + 32;
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Init<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Probe::LEN,
        seeds = [PROBE_SEED, authority.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub probe: Account<'info, Probe>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct DelegateProbe<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [PROBE_SEED, authority.key().as_ref(), &id.to_le_bytes()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: target validator
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct PermissionCtx<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [PROBE_SEED, probe.authority.as_ref(), &probe.id.to_le_bytes()],
        bump
    )]
    pub probe: Account<'info, Probe>,
    /// CHECK: checked by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, probe.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Poke<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub probe: Account<'info, Probe>,
}

#[derive(Accounts)]
pub struct TickReveal<'info> {
    #[account(
        mut,
        seeds = [PROBE_SEED, probe.authority.as_ref(), &probe.id.to_le_bytes()],
        bump
    )]
    pub probe: Account<'info, Probe>,
    /// CHECK: checked by the permission program
    #[account(mut, seeds = [PERMISSION_SEED, probe.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ScheduleReveal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: passed through
    #[account(mut)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: passed through
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PokePair<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub probe_a: Account<'info, Probe>,
    #[account(mut)]
    pub probe_b: Account<'info, Probe>,
}

#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(mut)]
    pub probe: Account<'info, Probe>,
}

#[derive(Accounts)]
pub struct ScheduleTicks<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: passed through to the crank
    #[account(mut)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestVrf<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub probe: Account<'info, Probe>,
    /// CHECK: queue
    #[account(mut, address = vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackVrf<'info> {
    #[account(mut)]
    pub probe: Account<'info, Probe>,
}
