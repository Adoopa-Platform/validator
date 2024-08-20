require('dotenv').config();

const { CORS_HEADERS, CONTRACT_ABI} = require('../config');
const { ethers, keccak256, AbiCoder, Wallet, Signature, getBytes } = require('ethers');
const { CastParamType, NeynarAPIClient, ReactionsType } = require('@neynar/nodejs-sdk');

const client = new NeynarAPIClient(process.env.NEYNAR_API_KEY);
const provider = new ethers.JsonRpcProvider(process.env.MAINNET_ENDPOINT);
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, CONTRACT_ABI, provider);

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const REACTION_HANDLERS = [findRecast, findQuote, findLike];

exports.handler = async (event) => {
    try {
        const offerId = event.queryStringParameters && event.queryStringParameters.offerId;

        if (!offerId) {
            return response(400, { error: 'No offerId provided' });
        }

        const validationResult = await validate(Number(offerId));
        return response(200, validationResult);
    } catch (error) {
        return response( 500, { error: 'Internal server error' });
    }
}

const response = (status, json) => {
    return {
        statusCode: status,
        headers: CORS_HEADERS,
        body: JSON.stringify(json)
    };
}

const validate = async (offerId) => {
    const offer = await fetchOfferById(Number(offerId));

    // Offer state must be ACCEPTED (1)
    if (offer.state !== 1) {
        return { offerId: offerId, result: false };
    }

    const reactionCreateTimeMs = await findReactionCreateTimeMs(offer.type, offer.receiverFid, offer.castHash);

    // if found no reaction that was created during 24h since accepting the offer
    // return 'false' result with signature (offer can be cancelled)
    if ((!reactionCreateTimeMs && Date.now() > offer.acceptTimeMs + DAY_IN_MS) ||
        reactionCreateTimeMs > offer.acceptTimeMs + DAY_IN_MS) {
        return generateSignature({ offerId: offerId, result: false });
    }

    // if reaction is found and the whole duration time has passed
    // return 'true' result with signature (offer can be completed)
    // otherwise if duration has not passed yet
    // return 'false' result without signature (no action can be performed on the offer)
    return (reactionCreateTimeMs && Date.now() > reactionCreateTimeMs + offer.durationMs)
        ? generateSignature({ offerId: offerId, result: true })
        : { offerId: offerId, result: false };
};

const findReactionCreateTimeMs = async (reactionType, receiverFid, castHash) => {
    const findReactionFunction = REACTION_HANDLERS[reactionType];
    const reaction = await findReactionFunction(receiverFid, castHash);
    return reaction ? new Date(reaction.reaction_timestamp || reaction.timestamp).valueOf() : null;
}

async function findQuote(receiverFid, castHash) {
    let cursor = null;

    try {
        while (true) {
            const response = await client.fetchAllCastsCreatedByUser(receiverFid, { cursor });
            const cast = response.result.casts.find(cast =>
                cast.embeds.some(embed =>
                    embed.castId &&
                    embed.castId.hash === castHash
                )
            );

            if (cast) {
                return cast;
            }

            cursor = response.result.next.cursor;

            if (!cursor) {
                break;
            }
        }
    } catch (error) {
        console.error('Error fetching quotes: ', error);
        return null;
    }

    return null;
}

async function findRecast(receiverFid, castHash)  {
    let cursor = null;

    try {
        while (true) {
            const response = await client.fetchReactionsForCast(castHash, ReactionsType.Recasts, { cursor });
            const recast = response.reactions.find(recast => recast.user.fid === receiverFid);

            if (recast) {
                return recast;
            }

            cursor = response.next.cursor;

            if (!cursor) {
                break;
            }
        }
    } catch (error) {
        console.error('Error fetching recasts: ', error)
        return null;
    }

    return null;
}

async function findLike(receiverFid, castHash)  {
    let cursor = null;

    try {
        while (true) {
            const response = await client.fetchReactionsForCast(castHash, ReactionsType.Likes, { cursor });
            const like = response.reactions.find(like => like.user.fid === receiverFid);

            if (like) {
                return like;
            }

            cursor = response.next.cursor;

            if (!cursor) {
                break;
            }
        }
    } catch (error) {
        console.error('Error fetching likes: ', error)
        return null;
    }

    return null;
}

const fetchOfferById = async (offerId) => {
    try {
        const offer = await contract.offers(offerId);
        const receiverAddress = offer[2];
        const acceptTimestamp = offer[5];
        const duration = offer[6];
        const castUrl = offer[7];
        const type = offer[8];
        const state = offer[9];
        const receiver = await client.lookupUserByCustodyAddress(receiverAddress);
        const cast = await client.lookUpCastByHashOrWarpcastUrl(castUrl, CastParamType.Url);

        return {
            id: offerId,
            state: Number(state),
            type: Number(type),
            receiverFid: receiver.user.fid,
            castHash: cast.cast.hash,
            durationMs: Number(duration) * 1000,
            acceptTimeMs: Number(acceptTimestamp) * 1000
        };
    } catch (error) {
        console.error(`Error fetching offer by id=${offerId}: `, error);
    }
};

const generateSignature = async (message) => {
    const dataHash = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "bool"], [message.offerId, message.result]));
    const wallet = new Wallet(process.env.PRIVATE_KEY);
    const signature = Signature.from(await wallet.signingKey.sign(getBytes(dataHash)));

    return {
        offer_id: message.offerId,
        result: message.result,
        v: signature.v,
        r: signature.r,
        s: signature.s
    };
}
