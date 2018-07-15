import * as chai from "chai";
import * as _ from "lodash";

import * as ABIDecoder from "abi-decoder";
import { BigNumber } from "bignumber.js";
import { ether } from "../../../utils/units";

// Types
import { Address, Bytes32, IssuanceOrder } from "../../../../types/common.js";

// Contract types
import { CoreContract } from "../../../../types/generated/core";
import { SetTokenContract } from "../../../../types/generated/set_token";
import { SetTokenFactoryContract } from "../../../../types/generated/set_token_factory";
import { StandardTokenMockContract } from "../../../../types/generated/standard_token_mock";
import { TakerWalletWrapperContract } from "../../../../types/generated/taker_wallet_wrapper";
import { TransferProxyContract } from "../../../../types/generated/transfer_proxy";
import { VaultContract } from "../../../../types/generated/vault";

// Artifacts
const Core = artifacts.require("Core");

// Core wrapper
import { CoreWrapper } from "../../../utils/coreWrapper";
import { ERC20Wrapper } from "../../../utils/erc20Wrapper";
import { ExchangeWrapper } from "../../../utils/exchangeWrapper";
import {
  generateFillOrderParameters,
  generateOrdersDataForOrderCount,
  generateOrdersDataWithIncorrectExchange,
  generateOrdersDataWithTakerOrders,
} from "../../../utils/orderWrapper";

// Log Testing Tools
import {
  assertLogEquivalence,
  getFormattedLogsFromTxHash
} from "../../../utils/logs";

import {
  getExpectedFillLog,
  getExpectedCancelLog,
} from "../../../utils/contract_logs/coreIssuanceOrder";

// Testing Set up
import { BigNumberSetup } from "../../../utils/bigNumberSetup";
import ChaiSetup from "../../../utils/chaiSetup";
BigNumberSetup.configure();
ChaiSetup.configure();
const { expect, assert } = chai;

import {
  IssuanceComponentDeposited,
} from "../../../utils/contract_logs/core";

import {
  assertTokenBalance,
  expectRevertError,
} from "../../../utils/tokenAssertions";

import {
  DEPLOYED_TOKEN_QUANTITY,
  ZERO,
  NULL_ADDRESS,
  DEFAULT_GAS,
  EXCHANGES,
} from "../../../utils/constants";

import { SCENARIOS } from "./coreIssuanceOrderScenarios";

contract("CoreIssuanceOrder::Scenarios", (accounts) => {
  const [
    ownerAccount,
    takerAccount,
    makerAccount,
    signerAccount,
    relayerAccount,
    mockSetTokenAccount,
    mockTokenAccount
  ] = accounts;

  let core: CoreContract;
  let transferProxy: TransferProxyContract;
  let vault: VaultContract;
  let setTokenFactory: SetTokenFactoryContract;
  let takerWalletWrapper: TakerWalletWrapperContract;

  const coreWrapper = new CoreWrapper(ownerAccount, ownerAccount);
  const erc20Wrapper = new ERC20Wrapper(ownerAccount);
  const exchangeWrapper = new ExchangeWrapper(ownerAccount);

  before(async () => {
    ABIDecoder.addABI(Core.abi);
  });

  after(async () => {
    ABIDecoder.removeABI(Core.abi);
  });

  beforeEach(async () => {
    core = await coreWrapper.deployCoreAsync();
    vault = await coreWrapper.deployVaultAsync();
    transferProxy = await coreWrapper.deployTransferProxyAsync();
    setTokenFactory = await coreWrapper.deploySetTokenFactoryAsync();
    takerWalletWrapper = await exchangeWrapper.deployTakerWalletExchangeWrapper(transferProxy);

    // TODO: Move these authorizations into setDefaultStateAndAuthrorizations
    await coreWrapper.addAuthorizationAsync(takerWalletWrapper, core.address);;
    await coreWrapper.addAuthorizationAsync(transferProxy, takerWalletWrapper.address);

    await coreWrapper.setDefaultStateAndAuthorizationsAsync(core, vault, transferProxy, setTokenFactory);
  });

  describe("#fillOrder", async () => {
    SCENARIOS.forEach(async (scenario) => {
      describe(scenario.description, async () => {
        let subjectCaller: Address;
        let subjectQuantityToIssue: BigNumber;
        let subjectExchangeOrdersData: Bytes32;

        const naturalUnit: BigNumber = ether(2);
        let deployedTokens: StandardTokenMockContract[] = [];
        let componentUnits: BigNumber[];
        let setToken: SetTokenContract;

        let setAddress: Address;
        let makerAddress: Address;
        let signerAddress: Address;
        let relayerAddress: Address;
        let componentAddresses: Address[];
        let defaultComponentAmounts: BigNumber[];
        let requiredComponents: Address[];
        let requiredComponentAmounts: BigNumber[];
        let makerToken: StandardTokenMockContract;
        let relayerToken: StandardTokenMockContract;
        let makerTokenAmount: BigNumber;
        let relayerTokenAmount: BigNumber = ether(1);
        let timeToExpiration: number;

        let issuanceOrderParams: any;

        beforeEach(async () => {
          deployedTokens = await erc20Wrapper.deployTokensAsync(scenario.tokenState.numberOfComponents + 2, ownerAccount);
          await erc20Wrapper.approveTransfersAsync(deployedTokens, transferProxy.address, ownerAccount);
          await erc20Wrapper.approveTransfersAsync(deployedTokens, transferProxy.address, signerAccount);
          await erc20Wrapper.approveTransfersAsync(deployedTokens, transferProxy.address, takerAccount);

          // Give taker its Set component tokens
          scenario.tokenState.takerAmounts.forEach(async (amount, idx) => {
            await erc20Wrapper.transferTokenAsync(deployedTokens[idx], takerAccount, amount, ownerAccount);
          });

          // Give maker its Set component tokens
          scenario.tokenState.makerAmounts.forEach(async (amount, idx) => {
            await erc20Wrapper.transferTokenAsync(deployedTokens[idx], takerAccount, amount, ownerAccount);
          });

          //Deposit maker tokens in Vault

          // Give maker and taker their maker and relayer tokens
          await erc20Wrapper.transferTokensAsync(deployedTokens.slice(-2), signerAccount, DEPLOYED_TOKEN_QUANTITY.div(2), ownerAccount);
          await erc20Wrapper.transferTokensAsync(deployedTokens.slice(-2), takerAccount, DEPLOYED_TOKEN_QUANTITY.div(2), ownerAccount);

          const componentTokens = deployedTokens.slice(0, scenario.tokenState.numberOfComponents);
          componentAddresses = _.map(componentTokens, (token) => token.address);
          componentUnits = _.map(componentTokens, () => ether(4)); // Multiple of naturalUnit
          setToken = await coreWrapper.createSetTokenAsync(
            core,
            setTokenFactory.address,
            componentAddresses,
            componentUnits,
            naturalUnit,
          );

          requiredComponentAmounts = _.map(componentUnits, (unit, idx) =>
            unit.mul(scenario.exchangeOrders.orderQuantity)
            .mul(scenario.issuanceOrderParams.takerWeightsToTransfer[idx]).div(naturalUnit));

          await coreWrapper.registerExchange(core, EXCHANGES.TAKER_WALLET, takerWalletWrapper.address);

          makerAddress = signerAccount;
          relayerAddress = relayerAccount;
          makerToken = deployedTokens.slice(-2, -1)[0];
          relayerToken = deployedTokens.slice(-1)[0];
          timeToExpiration = 10;

          issuanceOrderParams = await generateFillOrderParameters(
            setToken.address,
            signerAccount,
            makerAddress,
            componentAddresses,
            requiredComponentAmounts,
            makerToken.address,
            relayerAddress,
            relayerToken.address,
            scenario.exchangeOrders.orderQuantity,
            scenario.exchangeOrders.makerTokenAmount,
            timeToExpiration,
          );

          const takerAmountsToTransfer = _.map(componentUnits, (unit, idx) =>
            unit.mul(scenario.exchangeOrders.orderQuantity)
            .mul(scenario.exchangeOrders.requiredComponentWeighting[idx]).div(naturalUnit));

          subjectExchangeOrdersData = generateOrdersDataWithTakerOrders(
            makerToken.address,
            componentAddresses,
            takerAmountsToTransfer,
          );

          subjectCaller = takerAccount;
          subjectQuantityToIssue = ether(4);
        });

        async function subject(): Promise<string> {
          return core.fillOrder.sendTransactionAsync(
            issuanceOrderParams.addresses,
            issuanceOrderParams.values,
            issuanceOrderParams.requiredComponents,
            issuanceOrderParams.requiredComponentAmounts,
            subjectQuantityToIssue,
            issuanceOrderParams.signature.v,
            [issuanceOrderParams.signature.r, issuanceOrderParams.signature.s],
            subjectExchangeOrdersData,
            { from: subjectCaller },
          );
        }

        it("transfers the full maker token amount from the maker", async () => {
          const existingBalance = await makerToken.balanceOf.callAsync(signerAccount);
          await assertTokenBalance(makerToken, DEPLOYED_TOKEN_QUANTITY.div(2), signerAccount);

          await subject();

          const fullMakerTokenAmount = ether(10);
          const newBalance = await makerToken.balanceOf.callAsync(signerAccount);
          const expectedNewBalance = existingBalance.sub(fullMakerTokenAmount);
          await assertTokenBalance(makerToken, expectedNewBalance, signerAccount);
        });

        it("transfers the remaining maker tokens to the taker", async () => {
          const existingBalance = await makerToken.balanceOf.callAsync(subjectCaller);
          await assertTokenBalance(makerToken, DEPLOYED_TOKEN_QUANTITY.div(2), subjectCaller);

          await subject();

          const netMakerToTaker = ether(10);
          const expectedNewBalance = existingBalance.plus(netMakerToTaker);
          await assertTokenBalance(makerToken, expectedNewBalance, subjectCaller);
        });

        it("transfers the fees to the relayer", async () => {
          const existingBalance = await relayerToken.balanceOf.callAsync(relayerAddress);
          await assertTokenBalance(relayerToken, ZERO, relayerAddress);

          await subject();

          const expectedNewBalance = relayerTokenAmount.mul(2);
          await assertTokenBalance(relayerToken, expectedNewBalance, relayerAddress);
        });

        it("mints the correct quantity of the set for the maker", async () => {
          const existingBalance = await setToken.balanceOf.callAsync(signerAccount);

          await subject();

          await assertTokenBalance(setToken, existingBalance.add(subjectQuantityToIssue), signerAccount);
        });

        it("marks the correct amount as filled in orderFills mapping", async () => {
          const preFilled = await core.orderFills.callAsync(issuanceOrderParams.orderHash);
          expect(preFilled).to.be.bignumber.equal(ZERO);

          await subject();

          const filled = await core.orderFills.callAsync(issuanceOrderParams.orderHash);
          expect(filled).to.be.bignumber.equal(subjectQuantityToIssue);
        });

        it("emits correct LogFill event", async () => {
          const txHash = await subject();

          const formattedLogs = await getFormattedLogsFromTxHash(txHash);
          const expectedLogs = getExpectedFillLog(
            setToken.address,
            signerAccount,
            subjectCaller,
            makerToken.address,
            relayerAddress,
            relayerToken.address,
            subjectQuantityToIssue,
            ether(10),
            ether(2),
            issuanceOrderParams.orderHash,
            core.address
          );

          await assertLogEquivalence(expectedLogs, formattedLogs);
        });
      });
    });
  });
});
