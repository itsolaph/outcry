//! Test harness for Outcry on MagicSVM: one base ledger + one ephemeral ledger in process.
//! Helpers adapted from the MagicBlock engine examples' `test-utils` crate.

use anchor_lang::{prelude::Pubkey, AnchorDeserialize, Id, InstructionData, ToAccountMetas};
use magicblock_account::WritableAccount;
use ephemeral_rollups_sdk::{
    access_control::structs::EphemeralPermission,
    anchor::{DelegationProgram, MagicProgram},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    pda::{
        delegate_buffer_pda_from_delegated_account_and_owner_program,
        delegation_metadata_pda_from_delegated_account, delegation_record_pda_from_delegated_account,
    },
};
use magicsvm::{MagicSVM, TransactionTarget};
use outcry::{
    accounts, instruction,
    state::{PlayerRecord, Table, RECORD_SEED, SEAT_SEED, TABLE_SEED},
};
use solana_address::Address;
use solana_clock::Clock;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub use magicsvm;

pub const START_TS: i64 = 1_800_000_000;
pub const VRF_PROGRAM_ID: Pubkey = Pubkey::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
pub const DEFAULT_EPHEMERAL_QUEUE: Pubkey =
    Pubkey::from_str_const("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
pub const SLOT_HASHES: Pubkey = Pubkey::from_str_const("SysvarS1otHashes111111111111111111111111111");
pub const SYSTEM_PROGRAM: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");
pub const DELEGATION_PROGRAM: Address = Address::from_str_const("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
pub const COMPUTE_BUDGET: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");

pub fn as_pubkey(a: &Address) -> Pubkey {
    Pubkey::new_from_array(a.to_bytes())
}
pub fn as_address(p: Pubkey) -> Address {
    Address::new_from_array(p.to_bytes())
}

pub fn program_id() -> Pubkey {
    outcry::ID
}

pub fn ix(data: impl InstructionData, accts: impl ToAccountMetas) -> Instruction {
    Instruction {
        program_id: as_address(program_id()),
        accounts: accts
            .to_account_metas(None)
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: as_address(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: data.data(),
    }
}

pub fn cu_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data,
    }
}

pub fn sign_tx(signers: &[&Keypair], ixs: &[Instruction], blockhash: Hash) -> Transaction {
    let mut unique: Vec<&Keypair> = Vec::new();
    for s in signers {
        if !unique.iter().any(|u| u.pubkey() == s.pubkey()) {
            unique.push(s);
        }
    }
    Transaction::new(&unique, Message::new(ixs, Some(&unique[0].pubkey())), blockhash)
}

/// Sends and panics with logs on failure.
pub fn send(svm: &mut MagicSVM, target: TransactionTarget, signers: &[&Keypair], ixs: &[Instruction], label: &str) {
    let tx = sign_tx(signers, ixs, svm.latest_blockhash_for(target));
    if let Err(failed) = svm.send_transaction_to(target, tx) {
        panic!("{label} failed on {target:?}: {:?}\nlogs: {:#?}", failed.err, failed.meta.logs);
    }
    svm.expire_blockhash_for(target);
}

/// Sends and returns the error (and logs) if it failed.
pub fn try_send(
    svm: &mut MagicSVM,
    target: TransactionTarget,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, (TransactionError, Vec<String>)> {
    let tx = sign_tx(signers, ixs, svm.latest_blockhash_for(target));
    let r = svm.send_transaction_to(target, tx);
    svm.expire_blockhash_for(target);
    match r {
        Ok(meta) => Ok(meta.logs),
        Err(failed) => Err((failed.err, failed.meta.logs)),
    }
}

/// Anchor custom error code of `OutcryError` variant index `n`.
pub const fn err_code(n: u32) -> u32 {
    6000 + n
}

pub fn expect_custom(r: Result<Vec<String>, (TransactionError, Vec<String>)>, code: u32, label: &str) {
    match r {
        Ok(logs) => panic!("{label}: expected error {code}, got success\nlogs: {logs:#?}"),
        Err((err, logs)) => {
            let ok = matches!(
                err,
                TransactionError::InstructionError(_, solana_instruction::error::InstructionError::Custom(c)) if c == code
            );
            assert!(ok, "{label}: expected custom {code}, got {err:?}\nlogs: {logs:#?}");
        }
    }
}

pub fn set_time(svm: &mut MagicSVM, unix_timestamp: i64) {
    let mut clock = svm.base().get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
    let mut eclock = svm.ephemeral().get_sysvar::<Clock>();
    eclock.unix_timestamp = unix_timestamp;
    svm.ephemeral_mut().set_sysvar(&eclock);
}

pub fn er_slot(svm: &MagicSVM) -> u64 {
    svm.ephemeral().get_sysvar::<Clock>().slot
}

pub fn permission_pda(account: &Pubkey) -> Pubkey {
    as_pubkey(&EphemeralPermission::find_pda(&as_address(*account)).0)
}

/// Mirror of the program's `Seat` (Borsh) for decoding raw account data.
#[derive(AnchorDeserialize, Debug, Clone)]
pub struct SeatView {
    pub table: Pubkey,
    pub index: u8,
    pub bump: u8,
    pub round: u32,
    pub hand: [u8; 4],
    pub chips: u16,
    pub order_suit_a: u8,
    pub order_qty_a: u8,
    pub order_suit_b: u8,
    pub order_qty_b: u8,
}

impl SeatView {
    pub fn order(&self) -> outcry::game::OrderSpec {
        outcry::game::OrderSpec {
            suit_a: self.order_suit_a,
            qty_a: self.order_qty_a,
            suit_b: self.order_suit_b,
            qty_b: self.order_qty_b,
        }
    }
}

pub struct Outcry {
    pub svm: MagicSVM,
    pub creator: Keypair,
    pub table_id: u64,
    pub table: Pubkey,
    pub seats: [Pubkey; 4],
    pub perms: [Pubkey; 4],
}

impl Outcry {
    /// Creates, delegates and permissions a table with a 90 s window.
    pub fn new(table_id: u64) -> Self {
        let creator = Keypair::new();
        let mut svm = MagicSVM::new();
        let so = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/outcry.so");
        svm.add_program_from_file(as_address(program_id()), &so)
            .unwrap_or_else(|e| panic!("load {}: {e}", so.display()));
        svm.airdrop(&creator.pubkey(), 20_000_000_000).unwrap();
        set_time(&mut svm, START_TS);
        let creator_pk = as_pubkey(&creator.pubkey());
        let table = Pubkey::find_program_address(
            &[TABLE_SEED, creator_pk.as_ref(), &table_id.to_le_bytes()],
            &program_id(),
        )
        .0;
        let seats: [Pubkey; 4] = core::array::from_fn(|i| {
            Pubkey::find_program_address(&[SEAT_SEED, table.as_ref(), &[i as u8]], &program_id()).0
        });
        let perms: [Pubkey; 4] = core::array::from_fn(|i| permission_pda(&seats[i]));
        let mut s = Self {
            svm,
            creator,
            table_id,
            table,
            seats,
            perms,
        };
        let create = ix(
            instruction::CreateTable {
                table_id,
                window_secs: 90,
            },
            accounts::CreateTable {
                creator: creator_pk,
                table,
                seat0: seats[0],
                seat1: seats[1],
                seat2: seats[2],
                seat3: seats[3],
                system_program: SYSTEM_PROGRAM,
            },
        );
        let c = s.creator.insecure_clone();
        send(&mut s.svm, TransactionTarget::Base, &[&c], &[create], "create_table");
        let validator = as_pubkey(&s.svm.validator_identity());
        let del_table = ix(
            instruction::DelegateTable { table_id },
            accounts::DelegateTable {
                creator: creator_pk,
                buffer_table: delegate_buffer_pda_from_delegated_account_and_owner_program(&table, &program_id()),
                delegation_record_table: delegation_record_pda_from_delegated_account(&table),
                delegation_metadata_table: delegation_metadata_pda_from_delegated_account(&table),
                table,
                validator: Some(validator),
                owner_program: program_id(),
                delegation_program: DelegationProgram::id(),
                system_program: SYSTEM_PROGRAM,
            },
        );
        send(&mut s.svm, TransactionTarget::Base, &[&c], &[cu_limit(400_000), del_table], "delegate_table");
        for i in 0..4u8 {
            let seat = seats[i as usize];
            let del_seat = ix(
                instruction::DelegateSeat { index: i, _table_id: table_id },
                accounts::DelegateSeat {
                    creator: creator_pk,
                    table,
                    buffer_seat: delegate_buffer_pda_from_delegated_account_and_owner_program(&seat, &program_id()),
                    delegation_record_seat: delegation_record_pda_from_delegated_account(&seat),
                    delegation_metadata_seat: delegation_metadata_pda_from_delegated_account(&seat),
                    seat,
                    validator: Some(validator),
                    owner_program: program_id(),
                    delegation_program: DelegationProgram::id(),
                    system_program: SYSTEM_PROGRAM,
                },
            );
            send(&mut s.svm, TransactionTarget::Base, &[&c], &[cu_limit(400_000), del_seat], "delegate_seat");
        }
        let init = ix(
            instruction::InitPermissions {},
            accounts::SeatPermissions {
                signer: creator_pk,
                table,
                seat0: seats[0],
                seat1: seats[1],
                seat2: seats[2],
                seat3: seats[3],
                permission0: perms[0],
                permission1: perms[1],
                permission2: perms[2],
                permission3: perms[3],
                permission_program: as_pubkey(&PERMISSION_PROGRAM_ID),
                ephemeral_vault: as_pubkey(&EPHEMERAL_VAULT_ID),
                magic_program: as_pubkey(&MAGIC_PROGRAM_ID),
            },
        );
        send(&mut s.svm, TransactionTarget::Ephemeral, &[&c], &[cu_limit(600_000), init], "init_permissions");
        s
    }

    /// Send one instruction to the ER signed (and paid) by `k`; panics with logs on failure.
    pub fn er(&mut self, k: &Keypair, ix: Instruction, label: &str) {
        send(&mut self.svm, TransactionTarget::Ephemeral, &[k], &[ix], label);
    }

    /// Send one instruction to the ER and return the outcome.
    pub fn er_try(
        &mut self,
        k: &Keypair,
        ix: Instruction,
    ) -> Result<Vec<String>, (TransactionError, Vec<String>)> {
        try_send(&mut self.svm, TransactionTarget::Ephemeral, &[k], &[ix])
    }

    pub fn creator_pk(&self) -> Pubkey {
        as_pubkey(&self.creator.pubkey())
    }

    /// A funded keypair (base airdrop, so it exists as fee payer on both ledgers).
    pub fn player(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
        k
    }

    pub fn table_state(&self) -> Table {
        let acc = self
            .svm
            .get_account_for(TransactionTarget::Ephemeral, &as_address(self.table))
            .expect("table on ER");
        bytemuck_from(&acc.data[8..])
    }

    /// Raw seat read that bypasses permission filtering (test oracle).
    pub fn seat_raw(&self, i: usize) -> SeatView {
        let acc = self
            .svm
            .ephemeral()
            .get_account(&as_address(self.seats[i]))
            .expect("seat on ER");
        SeatView::deserialize(&mut &acc.data[8..]).unwrap()
    }

    /// Seat read as `viewer` would see it through the permission filter.
    pub fn seat_as(&mut self, viewer: Option<Pubkey>, i: usize) -> Option<SeatView> {
        self.svm.set_authorized_user(viewer.map(as_address));
        let r = self
            .svm
            .get_account_for(TransactionTarget::Ephemeral, &as_address(self.seats[i]))
            .map(|a| SeatView::deserialize(&mut &a.data[8..]).unwrap());
        self.svm.set_authorized_user(None);
        r
    }

    pub fn permission_private(&self, i: usize) -> (bool, Vec<Pubkey>) {
        let acc = self
            .svm
            .ephemeral()
            .get_account(&as_address(self.perms[i]))
            .expect("permission on ER");
        let p = EphemeralPermission::from_bytes(&acc.data).unwrap();
        // The permission program also lists the permissioned account's owner program; it can
        // never hold a TEE auth token, so only wallet members are returned here.
        (
            p.private,
            p.members
                .iter()
                .map(|m| as_pubkey(&m.pubkey))
                .filter(|k| *k != program_id())
                .collect(),
        )
    }

    /// Flags of every wallet member of seat `i`'s permission.
    pub fn member_flags(&self, i: usize) -> Vec<u8> {
        let acc = self
            .svm
            .ephemeral()
            .get_account(&as_address(self.perms[i]))
            .expect("permission on ER");
        let p = EphemeralPermission::from_bytes(&acc.data).unwrap();
        p.members
            .iter()
            .filter(|m| as_pubkey(&m.pubkey) != program_id())
            .map(|m| m.flags)
            .collect()
    }

    pub fn join_ix(&self, signer: &Keypair, wallet: Option<&Keypair>, seat: u8) -> Instruction {
        ix(
            instruction::Join { seat_index: seat },
            accounts::Join {
                signer: as_pubkey(&signer.pubkey()),
                wallet: wallet.map(|w| as_pubkey(&w.pubkey())),
                table: self.table,
            },
        )
    }

    pub fn join(&mut self, signer: &Keypair, wallet: Option<&Keypair>, seat: u8) {
        let j = self.join_ix(signer, wallet, seat);
        let mut signers = vec![signer];
        if let Some(w) = wallet {
            signers.push(w);
        }
        send(&mut self.svm, TransactionTarget::Ephemeral, &signers, &[j], "join");
    }

    pub fn start_round_ix(&self, signer: &Keypair, use_crank: bool) -> Instruction {
        let identity = Pubkey::find_program_address(&[b"identity"], &program_id()).0;
        ix(
            instruction::StartRound { use_crank },
            accounts::StartRound {
                signer: as_pubkey(&signer.pubkey()),
                table: self.table,
                seat0: self.seats[0],
                seat1: self.seats[1],
                seat2: self.seats[2],
                seat3: self.seats[3],
                permission0: self.perms[0],
                permission1: self.perms[1],
                permission2: self.perms[2],
                permission3: self.perms[3],
                permission_program: as_pubkey(&PERMISSION_PROGRAM_ID),
                ephemeral_vault: as_pubkey(&EPHEMERAL_VAULT_ID),
                magic_program: as_pubkey(&MAGIC_PROGRAM_ID),
                oracle_queue: DEFAULT_EPHEMERAL_QUEUE,
                program_identity: identity,
                vrf_program: VRF_PROGRAM_ID,
                slot_hashes: SLOT_HASHES,
                system_program: SYSTEM_PROGRAM,
            },
        )
    }

    /// Starts a round and runs the VRF callback (pinned randomness).
    pub fn start_and_deal(&mut self, signer: &Keypair, use_crank: bool, randomness: [u8; 32]) {
        self.svm.set_vrf_randomness(Some(randomness));
        let s = self.start_round_ix(signer, use_crank);
        send(&mut self.svm, TransactionTarget::Ephemeral, &[signer], &[cu_limit(1_000_000), s], "start_round");
        let slot = er_slot(&self.svm);
        let results = self.svm.warp_to_slot(slot + 1);
        let vrf_ok = results.iter().any(|r| match r {
            Ok(meta) => meta.logs.iter().any(|l| l.contains("Instruction: Deal")),
            Err(_) => false,
        });
        for r in &results {
            if let Err(f) = r {
                if f.meta.logs.iter().any(|l| l.contains("Instruction: Deal")) {
                    panic!("deal callback failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs);
                }
            }
        }
        assert!(vrf_ok, "deal callback did not run: {results:#?}");
        for meta in results.iter().flatten() {
            if meta.logs.iter().any(|l| l.contains("Instruction: Deal")) {
                for l in meta.logs.iter().filter(|l| l.contains(" consumed ")) {
                    println!("deal callback: {l}");
                }
            }
        }
    }

    pub fn act_ix(&self, signer: &Keypair, seat: u8, data: impl InstructionData) -> Instruction {
        ix(
            data,
            accounts::Act {
                signer: as_pubkey(&signer.pubkey()),
                table: self.table,
                seat: self.seats[seat as usize],
            },
        )
    }

    pub fn quote_ix(&self, signer: &Keypair, seat: u8, suit: u8, side: u8, price: u8) -> Instruction {
        self.act_ix(signer, seat, instruction::Quote { seat_index: seat, suit, side, price })
    }

    pub fn cancel_ix(&self, signer: &Keypair, seat: u8, suit: u8, side: u8) -> Instruction {
        self.act_ix(signer, seat, instruction::Cancel { seat_index: seat, suit, side })
    }

    pub fn take_ix(&self, signer: &Keypair, seat: u8, suit: u8, side: u8, counterparty: u8) -> Instruction {
        ix(
            instruction::Take { seat_index: seat, suit, side, counterparty },
            accounts::Take {
                signer: as_pubkey(&signer.pubkey()),
                table: self.table,
                seat: self.seats[seat as usize],
                counter_seat: self.seats[counterparty as usize],
            },
        )
    }

    pub fn settle_accounts(&self) -> accounts::Settle {
        accounts::Settle {
            table: self.table,
            seat0: self.seats[0],
            seat1: self.seats[1],
            seat2: self.seats[2],
            seat3: self.seats[3],
            permission0: self.perms[0],
            permission1: self.perms[1],
            permission2: self.perms[2],
            permission3: self.perms[3],
            permission_program: as_pubkey(&PERMISSION_PROGRAM_ID),
            ephemeral_vault: as_pubkey(&EPHEMERAL_VAULT_ID),
            magic_program: as_pubkey(&MAGIC_PROGRAM_ID),
        }
    }

    pub fn ring_bell_ix(&self) -> Instruction {
        ix(instruction::RingBell {}, self.settle_accounts())
    }

    pub fn bot_tick_ix(&self) -> Instruction {
        ix(instruction::BotTick {}, self.settle_accounts())
    }

    pub fn publish_records_ix(&self, payer: &Keypair) -> Instruction {
        ix(
            instruction::PublishRecords {},
            accounts::PublishRecords {
                payer: as_pubkey(&payer.pubkey()),
                table: self.table,
                program_id: program_id(),
                magic_program: MagicProgram::id(),
                magic_context: as_pubkey(&MAGIC_CONTEXT_ID),
            },
        )
    }

    pub fn undelegate_table_ix(&self, payer: &Keypair) -> Instruction {
        ix(
            instruction::UndelegateTable {},
            accounts::CloseOut {
                payer: as_pubkey(&payer.pubkey()),
                table: self.table,
                seat0: self.seats[0],
                seat1: self.seats[1],
                seat2: self.seats[2],
                seat3: self.seats[3],
                permission0: self.perms[0],
                permission1: self.perms[1],
                permission2: self.perms[2],
                permission3: self.perms[3],
                permission_program: as_pubkey(&PERMISSION_PROGRAM_ID),
                ephemeral_vault: as_pubkey(&EPHEMERAL_VAULT_ID),
                magic_program: MagicProgram::id(),
                magic_context: as_pubkey(&MAGIC_CONTEXT_ID),
            },
        )
    }

    /// Owner of `key` on the base layer.
    pub fn base_owner(&self, key: &Pubkey) -> Option<Pubkey> {
        self.svm
            .get_account_for(TransactionTarget::Base, &as_address(*key))
            .map(|a| as_pubkey(&a.owner))
    }

    pub fn record_pda(wallet: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[RECORD_SEED, wallet.as_ref()], &program_id()).0
    }

    pub fn init_record_ix(&self, payer: &Keypair, wallet: &Pubkey) -> Instruction {
        ix(
            instruction::InitRecord {},
            accounts::InitRecord {
                payer: as_pubkey(&payer.pubkey()),
                wallet: *wallet,
                record: Self::record_pda(wallet),
                system_program: SYSTEM_PROGRAM,
            },
        )
    }

    pub fn record(&self, wallet: &Pubkey) -> Option<PlayerRecord> {
        let acc = self.svm.get_account_for(TransactionTarget::Base, &as_address(Self::record_pda(wallet)))?;
        use anchor_lang::AccountDeserialize;
        PlayerRecord::try_deserialize(&mut &acc.data[..]).ok()
    }

    /// Overwrite a seat's private state on the ER (test setup only).
    pub fn poke_seat(&mut self, i: usize, hand: [u8; 4], chips: u16) {
        let addr = as_address(self.seats[i]);
        let mut acc = self.svm.ephemeral().get_account(&addr).expect("seat");
        // layout after the 8-byte discriminator: table 32, index 1, bump 1, round 4, hand 4, chips 2
        let off = 8 + 32 + 1 + 1 + 4;
        acc.data_as_mut_slice()[off..off + 4].copy_from_slice(&hand);
        acc.data_as_mut_slice()[off + 4..off + 6].copy_from_slice(&chips.to_le_bytes());
        self.svm.ephemeral_mut().set_account(addr, acc).unwrap();
    }
}

pub fn bytemuck_from<T: Copy>(bytes: &[u8]) -> T {
    assert!(bytes.len() >= core::mem::size_of::<T>());
    // Zero-copy accounts are plain-old-data; read without assuming alignment.
    unsafe { core::ptr::read_unaligned(bytes.as_ptr() as *const T) }
}
