'use strict'

const Validator = require('./models/blockchain/validator')
const Web3Ws = require('./models/blockchain/web3ws')
const web3Rpc = require('./models/blockchain/web3rpc')
const config = require('config')
const db = require('./models/mongodb')
const BigNumber = require('bignumber.js')
const moment = require('moment')
const logger = require('./helpers/logger')
const _ = require('lodash')

process.setMaxListeners(100)

var web3 = new Web3Ws()
var validator = new Validator(web3)
var cpValidator = 0

async function watchValidator () {
    var blockNumber = cpValidator || await web3.eth.getBlockNumber()
    try {
        blockNumber = blockNumber || await web3.eth.getBlockNumber()
        logger.info('TomoValidator %s - Listen events from block number %s ...',
            config.get('blockchain.validatorAddress'), blockNumber)

        cpValidator = await web3.eth.getBlockNumber()

        return validator.getPastEvents('allEvents', {
            fromBlock: blockNumber,
            toBlock: 'latest'
        }).then(async events => {
            let map = events.map(async (event) => {
                let result = event
                logger.debug('Event %s in block %s', result.event, result.blockNumber)
                if (result.event === 'Withdraw') {
                    let owner = (result.returnValues._owner || '').toLowerCase()
                    let capacity = result.returnValues._cap
                    return db.Withdraw.updateOne({
                        tx: result.transactionHash
                    }, {
                        $set: {
                            smartContractAddress: config.get('blockchain.validatorAddress'),
                            blockNumber: result.blockNumber,
                            tx: result.transactionHash,
                            owner: owner,
                            capacity: capacity
                        }
                    }, { upsert: true })
                }
                let candidate = (result.returnValues._candidate || '').toLowerCase()
                let voter = (result.returnValues._voter || '').toLowerCase()
                let owner = (result.returnValues._owner || '').toLowerCase()
                if (!voter && (event.event === 'Resign' || event.event === 'Withdraw' || event.event === 'Propose')) {
                    voter = owner
                }
                let capacity = result.returnValues._cap
                let blk = await web3.eth.getBlock(result.blockNumber)
                let createdAt = moment.unix(blk.timestamp).utc()
                await db.Transaction.updateOne({
                    tx: result.transactionHash
                }, {
                    $set: {
                        smartContractAddress: config.get('blockchain.validatorAddress'),
                        tx: result.transactionHash,
                        event: result.event,
                        voter: voter,
                        owner: owner,
                        candidate: candidate,
                        capacity: capacity,
                        blockNumber: result.blockNumber,
                        createdAt: createdAt
                    }
                }, {
                    upsert: true
                })
                if (result.event === 'Vote' || result.event === 'Unvote') {
                    await updateVoterCap(candidate, voter)
                }
                if (result.event === 'Resign' || result.event === 'Propose') {
                    await updateVoterCap(candidate, owner)
                }
                await updateCandidateInfo(candidate)
            })

            return Promise.all(map)
        }).catch(e => {
            logger.error('watchValidator %s', e)
            cpValidator = blockNumber
            web3 = new Web3Ws()
            validator = new Validator(web3)
        })
    } catch (e) {
        logger.error('watchValidator2 %s', e)
        cpValidator = blockNumber
    }
}

async function updateCandidateInfo (candidate) {
    try {
        let capacity = await validator.methods.getCandidateCap(candidate).call()
        let owner = (await validator.methods.getCandidateOwner(candidate).call() || '').toLowerCase()
        let status = await validator.methods.isCandidate(candidate).call()
        let result
        logger.debug('Update candidate %s capacity %s %s', candidate, String(capacity), status)
        if (candidate !== '0x0000000000000000000000000000000000000000') {
            // check current status
            const candateInDB = await db.Candidate.findOne({
                smartContractAddress: config.get('blockchain.validatorAddress'),
                candidate: candidate
            }) || {}

            status = (status)
                ? ((candateInDB.status === 'RESIGNED') ? 'PROPOSED' : (candateInDB.status || 'PROPOSED'))
                : 'RESIGNED'
            result = await db.Candidate.updateOne({
                smartContractAddress: config.get('blockchain.validatorAddress'),
                candidate: candidate
            }, {
                $set: {
                    smartContractAddress: config.get('blockchain.validatorAddress'),
                    candidate: candidate,
                    capacity: String(capacity),
                    capacityNumber: (new BigNumber(capacity)).div(1e18).toString(10),
                    status: status,
                    owner: owner
                },
                $setOnInsert: {
                    nodeId: candidate.replace('0x', '')
                }
            }, { upsert: true })
        } else {
            result = await db.Candidate.deleteOne({
                smartContractAddress: validator.address,
                candidate: candidate
            })
        }

        return result
    } catch (e) {
        logger.error('updateCandidateInfo %s', e)
    }
}

async function updateCandidateSlashed (candidate, blockNumber) {
    try {
        let result
        logger.debug('Update candidate %s slashed at blockNumber %s', candidate, String(blockNumber))
        if (candidate !== '0x0000000000000000000000000000000000000000') {
            result = await db.Candidate.updateOne({
                smartContractAddress: config.get('blockchain.validatorAddress'),
                candidate: candidate.toLowerCase()
            }, {
                $set: {
                    status: 'SLASHED'
                }
            }, { upsert: true })
        } else {
            result = await db.Candidate.deleteOne({
                smartContractAddress: validator.address,
                candidate: candidate
            })
        }

        return result
    } catch (e) {
        logger.error('updateCandidateSlashed %s', e)
    }
}

async function updateVoterCap (candidate, voter) {
    try {
        let capacity = await validator.methods.getVoterCap(candidate, voter).call()
        logger.debug('Update voter %s for candidate %s capacity %s', voter, candidate, String(capacity))
        return await db.Voter.updateOne({
            smartContractAddress: config.get('blockchain.validatorAddress'),
            candidate: candidate,
            voter: voter
        }, {
            $set: {
                smartContractAddress: config.get('blockchain.validatorAddress'),
                candidate: candidate,
                voter: voter,
                capacity: String(capacity),
                capacityNumber: (new BigNumber(capacity)).div(1e18).toString(10)
            }
        }, { upsert: true })
    } catch (e) {
        logger.error('updateVoterCap %s', e)
    }
}

// Get current candates
async function getCurrentCandidates () {
    try {
        let candidates = await validator.methods.getCandidates().call()
        let candidatesInDb = await db.Candidate.find({
            smartContractAddress: config.get('blockchain.validatorAddress')
        }).lean().exec()
        candidatesInDb = candidatesInDb.map(c => c.candidate)
        candidates = _.uniqBy(_.concat(candidates, candidatesInDb), (it) => {
            return it.toLowerCase()
        })

        let map = candidates.map(async (candidate) => {
            candidate = (candidate || '').toLowerCase()
            let voters = await validator.methods.getVoters(candidate).call()
            let m = voters.map(v => {
                v = (v || '').toLowerCase()
                return updateVoterCap(candidate, v)
            })

            await Promise.all(m)
            return updateCandidateInfo(candidate)
        })
        return Promise.all(map).catch(e => logger.error('getCurrentCandidates %s', e))
    } catch (e) {
        logger.error('getCurrentCandidates2 %s', e)
    }
}

async function updatePenalties () {
    try {
        let blks = []
        let latestBlockNumber = await web3.eth.getBlockNumber()
        let lastCheckpoint = latestBlockNumber - (latestBlockNumber % parseInt(config.get('blockchain.epoch')))

        for (let i = 0; i <= 4; i++) {
            let checkpoint = lastCheckpoint - (i * 900)
            if (checkpoint > 0) {
                blks.push(await web3.eth.getBlock(checkpoint))
            }
        }

        if (blks.length === 0) {
            return false
        }

        // await db.Penalty.remove({})

        let getPenalty = async function (blk) {
            let sbuff = Buffer.from((blk.penalties || '').substring(2), 'hex')
            let penalties = []
            const epoch = (blk.number / config.get('blockchain.epoch')) - 1
            if (sbuff.length > 0) {
                for (let i = 1; i <= sbuff.length / 20; i++) {
                    let address = sbuff.slice((i - 1) * 20, i * 20)
                    penalties.push('0x' + address.toString('hex'))
                    await updateCandidateSlashed('0x' + address.toString('hex').toLowerCase(), blk.number)
                }

                await db.Penalty.update({ epoch: epoch }, {
                    networkId: config.get('blockchain.networkId'),
                    blockNumber: blk.number,
                    epoch: epoch,
                    penalties: penalties
                }, { upsert: true })
            }
            return penalties
        }

        await Promise.all(blks.map(blk => getPenalty(blk)))
    } catch (e) {
        logger.error('updatePenalties %s', e)
        web3 = new Web3Ws()
        validator = new Validator(web3)
    }
}

async function updateSignersAndCandidate () {
    try {
        let blk = {}
        let latestBlockNumber = await web3.eth.getBlockNumber()
        let lastCheckpoint = latestBlockNumber - (latestBlockNumber % parseInt(config.get('blockchain.epoch')))
        if (lastCheckpoint > 0) {
            blk = await web3.eth.getBlock(lastCheckpoint)
        } else {
            return false
        }
        let buff = Buffer.from(blk.extraData.substring(2), 'hex')
        let sbuff = buff.slice(32, buff.length - 65)
        let signers = []
        let address
        if (sbuff.length > 0) {
            for (let i = 1; i <= sbuff.length / 20; i++) {
                address = sbuff.slice((i - 1) * 20, i * 20)
                signers.push('0x' + address.toString('hex'))
                // update candidate status
                await db.Candidate.updateOne({
                    smartContractAddress: config.get('blockchain.validatorAddress'),
                    candidate: '0x' + address.toString('hex').toLowerCase()
                }, {
                    $set: {
                        status: 'MASTERNODE'
                    }
                }, { upsert: true })
            }
            await db.Signer.create({
                networkId: config.get('blockchain.networkId'),
                blockNumber: blk.number,
                signers: signers
            })
        }
        return signers
    } catch (e) {
        logger.error('updateSignersAndCandidate %s', e)
    }
}

let sleep = (time) => new Promise((resolve) => setTimeout(resolve, time))
async function watchNewBlock (n) {
    try {
        let blockNumber = await web3.eth.getBlockNumber()
        n = n || blockNumber
        if (blockNumber > n) {
            n = n + 1
            blockNumber = n
            logger.info('Watch new block every 1 second blkNumber %s', n)
            let blk = await web3.eth.getBlock(blockNumber)
            if (n % 5 === 0) {
                // reset status
                await db.Candidate.updateMany({ status: { $nin: ['RESIGNED'] } }, { $set: { status: 'PROPOSED' } })
                await updateSignersAndCandidate()
                await updatePenalties()
            }
            await updateLatestSignedBlock(blk)
            await watchValidator()
        }
    } catch (e) {
        logger.error('watchNewBlock %s', e)
        web3 = new Web3Ws()
        validator = new Validator(web3)
    }
    await sleep(1000)
    return watchNewBlock(n)
}

async function updateLatestSignedBlock (blk) {
    try {
        for (let hash of ((blk || {}).transactions || [])) {
            let tx = await web3Rpc.eth.getTransaction(hash)
            if (tx.to === config.get('blockchain.blockSignerAddress')) {
                let signer = tx.from
                let buff = Buffer.from((tx.input || '').substring(2), 'hex')
                let sbuff = buff.slice(buff.length - 32, buff.length)
                let bN = ((await web3Rpc.eth.getBlock('0x' + sbuff.toString('hex'))) || {}).number
                if (!bN) {
                    logger.debug('Bypass signer %s sign %s', signer, '0x' + sbuff.toString('hex'))
                    continue
                }
                logger.debug('Sign block %s by signer %s', bN, signer)
                await db.Candidate.updateOne({
                    smartContractAddress: config.get('blockchain.validatorAddress'),
                    candidate: signer.toLowerCase()
                }, {
                    $set: {
                        latestSignedBlock: bN
                    }
                }, { upsert: false })
            }
        }
    } catch (e) {
        logger.error('updateLatestSignedBlock %s', e)
    }
}

async function getPastEvent () {
    let blockNumber = await web3.eth.getBlockNumber()
    let lastBlockTx = await db.Transaction.findOne().sort({ blockNumber: -1 })
    let lb = (lastBlockTx && lastBlockTx.blockNumber) ? lastBlockTx.blockNumber : 0

    logger.debug('Get all past event from block', lb, 'to block', blockNumber)
    validator.getPastEvents('allEvents', { fromBlock: lb, toBlock: blockNumber }, async function (error, events) {
        if (error) {
            logger.error(error)
        } else {
            let map = events.map(async function (event) {
                if (event.event === 'Withdraw') {
                    let owner = (event.returnValues._owner || '').toLowerCase()
                    let blockNumber = event.blockNumber
                    let capacity = event.returnValues._cap
                    await db.Withdraw.findOneAndUpdate({ tx: event.transactionHash }, {
                        smartContractAddress: config.get('blockchain.validatorAddress'),
                        blockNumber: blockNumber,
                        tx: event.transactionHash,
                        owner: owner,
                        capacity: capacity
                    }, { upsert: true })
                }
                let candidate = (event.returnValues._candidate || '').toLowerCase()
                let voter = (event.returnValues._voter || '').toLowerCase()
                let owner = (event.returnValues._owner || '').toLowerCase()
                if (!voter && (event.event === 'Resign' || event.event === 'Withdraw' || event.event === 'Propose')) {
                    voter = owner
                }
                let capacity = event.returnValues._cap
                let blk = await web3.eth.getBlock(event.blockNumber)
                let createdAt = moment.unix(blk.timestamp).utc()
                await db.Transaction.updateOne({ tx: event.transactionHash }, {
                    smartContractAddress: config.get('blockchain.validatorAddress'),
                    tx: event.transactionHash,
                    blockNumber: event.blockNumber,
                    event: event.event,
                    voter: voter,
                    owner: owner,
                    candidate: candidate,
                    capacity: capacity,
                    createdAt: createdAt
                }, { upsert: true })
            })
            return Promise.all(map)
        }
    })
}

getCurrentCandidates().then(() => {
    return updatePenalties()
}).then(() => {
    return updateSignersAndCandidate()
}).then(() => {
    return getPastEvent().then(() => {
        watchNewBlock()
    })
}).catch(e => {
    logger.error('Start error %s', e)
})
